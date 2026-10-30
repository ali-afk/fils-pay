# Design: io_uring optimization — where and how in FilsPay

> Placement note: this plan lives at `docs/plans/` per the planning-lane contract. Sibling design docs (e.g. `docs/design/json-in-postgres-vs-app.md`) live under `docs/design/`; the orchestrator may relocate this file when the lanes land.

| | |
|---|---|
| **Author** | AI planning lane (io_uring), coordinated with the batch-commit and JSON-in-Postgres lanes |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — nothing here is implemented. No file outside `docs/plans/` is touched by this lane. |

This is the *how-we-will-do-it* document for "where can we use io_uring in this
app to optimize it". It inventories every I/O surface in the repo, reasons about
each against verified 2026 io_uring facts, and gives a per-site implementation
plan with benefit, risk, and a fail-safe check. It does **not** change code; the
implementation is a separate, later lane.

---

## TL;DR — the honest answer first

io_uring is a Linux kernel API for async I/O (submitting many reads/writes to a
ring the kernel completes without one syscall each). It is **not** a tool you
bolt onto SQL queries or HTTP handlers directly, and two of the three service
runtimes here cannot use it at all from application code. Where it actually pays
off in this repo, in ROI order:

| # | Lever | What changes | Rough win |
|---|---|---|---|
| 1 | **Unblock io_uring in the containers** | The compose stack runs Docker/Podman, whose default seccomp profiles **block `io_uring_setup`** (current Docker and Podman default profiles). Nothing below works until this is fixed. | unlocks 2 and 3 |
| 2 | **Postgres 16 -> 18 + async I/O** | `postgres:16-alpine` has no io_uring; PG18 (out since ~Sep 2025) ships an async-I/O subsystem (`io_method`, liburing compiled into the official image since PR #1366) that overlaps reads for seq scans / COPY / VACUUM / ANALYZE / bitmap scans. | best win for the settlement and reporting read paths |
| 3 | **Run the TS services on Bun (not Node/tsx)** | Bun's Linux runtime is built around io_uring (it refuses kernels < 5.1 with "…doesn't support io_uring, which Bun depends on"). **Decision (2026-10-30): runtime = Bun** — compose already invokes `bun`; `tsx` under Node (dev tooling, fp-209 load test) is legacy. Verify with strace. | free io_uring for sockets/files; startup + memory wins |
| 4 | **Leave the Go settlement alone (no raw io_uring)** | Go's stdlib deliberately does not integrate io_uring (tracking issue #31908 open since 2019; proposal #57701 closed not-planned). Third-party bindings are dormant and their own author argues runtime integration is required for real gains. The settlement worker is DB-over-TCP + one small file write anyway. Its real lever is Postgres-side (item 2) and `pgx` COPY batching (the batch-commit lane owns that). | avoided complexity, not a "no" without evidence |

The one site where io_uring would *not* help even with everything unlocked: the
CSV export and every other path that is socket-bound to Postgres or to an HTTP
client — io_uring on the client side does not reduce TCP round trips, and the
repo deliberately keeps the export in memory (see Site C below).

---

## 1. What io_uring is (two paragraphs for a beginner)

Normal file and socket I/O makes the kernel do the work and then blocks the
process until the result is ready. io_uring (Linux 5.1+) replaces that with a
**ring buffer**: the program writes "read these 100 pages" onto a submission
queue, the kernel completes them on a completion queue, and the program keeps
computing while the I/O happens. It removes per-I/O syscalls and lets many I/Os
be batched — exactly the shape of Postgres reading a big table during a batch
close, or a runtime accepting thousands of connections.

It is **not** a magic flag on an application: someone has to *use* it — the
runtime (Bun does), the database server (Postgres 18 does), or your own native
code (not Go stdlib). That is why this plan has exactly three real levers.

## 2. Repo I/O map (the surfaces, with file:line evidence)

All line numbers verified against `main` on 2026-10-30. This lane only reads
these files.

| # | Surface | Evidence | Kind of I/O |
|---|---|---|---|
| A | Transaction CSV export | `apps/api/src/routes/transactions.ts:161-171` (route calls `buildTransactionsExportCsv`), `apps/api/src/transactions/exportCsv.ts:31-51` (in-memory build), `:53-87` (cursor-paged stream variant, unused by the route) | DB read -> HTTP response, in-memory CSV string |
| B | Admin adjustment CSV import | `apps/api/src/admin/adjustmentCsvParsing.ts:26-47` | request body -> DB writes (small) |
| C | KYC upload + thumbnail files | `apps/api/src/onboarding/kyc.ts:73-84` (`writeFile` upload + thumb), `:196`/`:223` (`readFile`), `apps/api/src/onboarding/kycThumbnail.ts:32` (sharp re-encode) | multipart -> disk writes/reads; image decode/encode (CPU) |
| D | pg connection pool (API) | `apps/api/src/db/pool.ts:16-18` (`max: 5`, 0.5 vCPU/512 MB rationale) | TCP to Postgres |
| E | Webhook dispatcher outbox poll + LISTEN | `apps/api/src/webhooks/dispatcher.ts:95` (join on `payload->>'merchantId'` in SQL), `:300` (LISTEN client) | SQL reads + per-row INSERTs + HTTP POSTs |
| F | Reporting read model worker | `apps/reporting/src/consumer/runConsumerPass.ts:47-58` (batch SELECT + per-event rollup upserts in ONE transaction), `apps/reporting/src/db/pool.ts:13`, `apps/reporting/src/config.ts` (`consumerBatchLimit` 500, poll 15 s) + `listener.ts:44` (LISTEN) | SQL reads/writes |
| G | Settlement batch close | `apps/settlement/internal/settlement/batch.go` (`CloseBatch`: one transaction, `FOR UPDATE` row lock, capture claim, fee compute, legs + export lines), `apps/settlement/internal/db/pool.go:27-28` (pool cap) | DB-bound (pgx over TCP); CPU fee math |
| H | Scheme file export | `apps/settlement/internal/settlement/scheme_export.go:141` (`os.WriteFile` of a strings.Builder) | one small file write per batch |
| I | Settlement internal admin API | `apps/settlement/internal/internalapi/server.go` (`net/http` + `http.ServeMux`) | tiny HTTP surface, DB calls |
| J | Shared outbox insert | `packages/events/src/outbox.ts` (`enqueueEvent`, INSERT inside caller's transaction) | DB write |
| K | Postgres server itself | `ops/docker-compose.yml` (`postgres:16-alpine`; api+reporting commands run `bun`) | all of the above |
| L | Known perf precedent | `docs/perf/2026-07-settlement-summary-slow.md` (shared_buffers 32->128 MB cut 3.4 s -> 410 ms warm), `docs/perf/fp-209-loadtest-2026-09.md` (Node 20-slim + `npx tsx`; export p50 2.21 s; peak RSS 236 MB fine) | DB tuning + runtime evidence |

Other lanes today: the **batch-commit lane** owns `apps/settlement/internal/settlement/batch.go` and its tests; the **JSON-in-Postgres lane** owns `apps/api/src/webhooks/archiveReplay.ts` / `replayBatch.ts` and its review plan at `docs/design/json-in-postgres-vs-app.md`. This document touches none of their files.

## 3. The plan, site by site (ordered by ROI)

### Site 1 — unblock io_uring in the container runtime (P0, hard dependency)

- **Facts.** Docker's default seccomp profile blocks `io_uring_enter`, `io_uring_register`, `io_uring_setup` ("Blocked due to security vulnerabilities that can be exploited to break out of containers" — see the current default profile, moby/moby#46762). Podman's default profile (containers/common seccomp.json) blocks the same three syscalls; containers/podman#12671 confirms io_uring syscalls fail with EPERM under seccomp unless the container runs with a permissive profile, and that the image-manifest annotation (`io.podman.annotations.seccomp=unconfined`) does **not** work — only the CLI flag does.
- **Plan.** Add a compose-level seccomp override for the api / reporting / postgres services:
  - Docker: `security_opt: [ "seccomp=unconfined" ]` for a dev stack, or better a custom profile (copy the default from docker-library and add the three io_uring syscalls to the allowlist) for anything longer-lived.
  - Podman rootless (this dev box, per ops notes): `podman-compose` reads the same `security_opt`; verify with `podman info --format '{{.Host.Security.SeccompProfilePath}}'` and the runtime check below.
- **Benefit / risk.** Enables everything else; the security trade-off is real (io_uring has been a source of kernel CVE kernels; Google disabled it widely), so the custom-profile variant is the recommended long-term posture, never `unconfined` in production without a written risk sign-off.
- **Fail-safe check.** Inside the container: `strace -e io_uring_setup <the real command>` must show a successful `io_uring_setup(...) = N`; a blocked profile returns EPERM (Docker/Podman) — or run `grep Seccomp /proc/self/status` (a `2` here means a filter is active).

### Site 2 — Postgres 16 -> 18 and turn on async I/O (P1, biggest win)

- **Facts.** PG18 adds a full async-I/O subsystem: `io_method` (`sync` | `worker` (default, dedicated background processes) | `io_uring`), `io_workers` (default 3), and `effective_io_concurrency` default raised from 1 (PG17) to 16 — see the PG18 guides (neon.com/postgresql/18/asynchronous-io, betterstack). PG17 was still strictly synchronous (streaming reads with `posix_fadvise` hints, ~30% faster seq scans in some workloads; credativ). Upstream added the liburing dependency in commit `8eadd5c`, and the **official Docker image added liburing to the 18+ build** (docker-library/postgres#1366, merged Sep 2025) — so `postgres:18(-alpine)` can do io_uring, `postgres:16-alpine` (current) cannot.
- **Plan.** (a) Move `ops/docker-compose.yml` + the hosted box's image to `postgres:18-alpine`; (b) set `io_method = io_uring` (or benchmark `worker` vs `io_uring` first — PG18's AIO targets heap seq scans, COPY, VACUUM/ANALYZE, bitmap scans; B-tree index scans, small OLTP lookups, writes and WAL are still synchronous, so expects gains on the settlement/reporting batch reads, not on OLTP); (c) with 128 MB shared_buffers already proven (perf doc L), also re-check `effective_io_concurrency` / `maintenance_io_concurrency` on the new major.
- **Benefit / risk.** Directly amplifies the batch-commit lane's close pass (large `transaction_events` reads), the JSON lane's set-based SQL pushes (archive build reads a whole range), and any VACUUM/ANALYZE on big tables. Risk: PG18 AIO is freshly shipped; some operators (e.g. Neon's own note) run `io_method='sync'` initially while the ecosystem matures — the plan keeps the benchmark-first posture below. The migration 16->18 is a major-version upgrade for the whole DB (all services' queries), so it is its own tracked task with a rollback image.
- **Fail-safe check.** After upgrade, `SHOW io_method` + `pg_config --configure | grep -o liburing` (empty means the binary lacks io_uring support) + re-run the `docs/perf/` scenarios (`GET /v1/settlement/summary`, export, batch close) and compare times to the published baselines.

### Site 3 — one TS runtime: Bun (P2; compose already points there)

- **Facts.** Bun's Linux runtime is built around io_uring: older Bun hard-failed on kernels < 5.1 with "Linux kernel version doesn't support io_uring, which Bun depends on" (oven-sh/bun#785, #838) and used io_uring for `bun install`/`fetch`; the runtime docs sell its fast start/run profile (bun.com/docs/runtime). Node.js has **no** io_uring in `libuv`. **Decision (2026-10-30, orchestrator): Bun is the runtime for apps/api and apps/reporting** — `ops/docker-compose.yml` already runs `["bun", "apps/api/src/index.ts"]` and `["bun", "apps/reporting/src/index.ts"]`; running under `tsx`/Node (dev tooling, fp-209 load-test posture) is legacy to retire. (ops/ has no `Dockerfile.node`/`Dockerfile.go` right now — when restored they must pin Bun; that stays an ops-lane ask, flag, do not fix here.)
- **Plan.** (a) Decided 2026-10-30: Bun is the *only* runtime for api + reporting (container and dev script); retire `tsx`; (b) verify the three native deps on Bun: `pg` (pure JS, fine), `argon2` (native build — must compile for Bun's ABI or fall back to the bundled build), `sharp` (libvips prebuilt — must load under Bun; kycThumbnail is its only consumer); (c) confirm Site 1 before shipping, then (d) measure: `strace -f -e trace=io_uring_setup` one boot, and re-run fp-209's k6 scenarios for a Bun-vs-Node delta.
- **Benefit / risk.** Free io_uring on sockets/files + documented 2-2.5x faster startup and lower memory; risk is the native-module ABI and subtle runtime differences (pg's socket handling, `@fastify/multipart` buffer behavior) — mitigated by the per-dep smoke tests and the fact the compose file already runs Bun today (so the risk is "make dev match prod" rather than "adopt something untested").
- **Fail-safe check.** `bun test` green in `apps/api` and `apps/reporting` under Bun; k6 rerun shows no regression vs the fp-209 numbers; `strace -e io_uring_setup` shows the ring being created at boot.

### Site 4 — CSV export: keep the deliberate in-memory build (P3, mostly a "no")

- **Facts / plan.** `AGENTS.md` records the in-memory load as intentional (date range keeps result sets small); the route calls `buildTransactionsExportCsv`, and a `streamTransactionsExportCsv` (cursor, LIMIT 1000) already exists at `exportCsv.ts:53`. Neither is io_uring territory: the data comes from Postgres over TCP and leaves over an HTTP socket; client-side io_uring would only batch syscalls that are already cheap. The fp-209 numbers confirm the current memory profile is safe.
- **Action.** None for io_uring. If the orchestrator wants a change here anyway, it is a route-level decision to switch `transactions.ts:161` to the existing stream variant — unrelated to io_uring, and a separate ticket.

### Site 5 — KYC files and thumbnails (P3, marginal)

- **Facts / plan.** Uploads are written and re-read with `node:fs/promises` (`kyc.ts:73-84`, `:196`, `:223`); thumbnails are `sharp` re-encodes (`kycThumbnail.ts:32`) — CPU-bound libvips, where io_uring buys nothing. If Bun becomes the runtime (Site 3), these file calls ride Bun's io_uring-backed fs path automatically. A raw-io_uring rewrite here is unjustified at 8 MiB cap and low volume.
- **Action.** None beyond Site 3.

### Site 6 — settlement (Go): explicitly do NOT add io_uring (P3, a documented "no")

- **Facts.** Go's stdlib has no io_uring: the tracking proposal is still open since 2019 (golang/go#31908, and the team's stated difficulty fitting it transparently into the netpoller), and the explicit async-file-I/O proposal was closed "not planned" (golang/go#57701). The maintained userland bindings are dormant: `iceber/iouring-go` has no released versions and its author's own write-up concludes real gains require integrating io_uring into the Go runtime itself.
- **Plan.** Keep the settlement worker on pgx + netpoller. Its I/O is (G) Postgres over TCP and (H) one serialized file per batch — neither is an io_uring shape. The batch-commit lane owns the real lever (pgx COPY/multi-row insert batching in `CloseBatch`), and the PG18 change (Site 2) accelerates its reads server-side.
- **Fail-safe check.** No new Go dependency; settle on the documented-benchmark comparison after Site 2 rather than a new syscall path.

### Site 7 — dispatcher and reporting consumer (P3, no client-side io_uring)

- **Facts / plan.** Both are DB- and network-bound with small batches (`dispatcher.ts:95`, `runConsumerPass.ts:47-58`); io_uring on the client adds nothing. Their levers are already in motion: set-based SQL (JSON lane) and PG18 async reads (Site 2).
- **Action.** None.

## 4. What this lane will NOT do (so nobody "helpfully" extends it)

- No raw io_uring code in TypeScript, no `io-uring` npm native addons on the Node path (unmaintained, ABI-fragile); the runtime switch is the mechanism.
- No io_uring dependency in the Go module (`go.mod` stays as is).
- No change to `packages/money`, no test file edits, no monetary-column widening (repo AGENTS.md hard rules — a plan lane does not even draft these).
- No change to `v1/` API stubs or `WEBHOOK_ELIGIBLE_EVENT_TYPES`.
- No edits to files the batch-commit or JSON-in-Postgres lanes own (see §5).

## 5. Coordination with the in-flight lanes (disjoint scopes)

| Lane | Owns | This plan's touchpoints there |
|---|---|---|
| Batch-commit | `apps/settlement/internal/settlement/batch.go` + `batch_test.go` (batching/transaction batching) | Reads only; recommends PG18 (Site 2) as the server-side amplifier of their batch reads; explicitly passes the COPY idea to them, does not implement it |
| JSON-in-Postgres | `apps/api/src/webhooks/archiveReplay.ts` / `replayBatch.ts`, `docs/design/json-in-postgres-vs-app.md` (set-based SQL for sites 5/6/7) | Reads their plan (§3 there) and cites it; Site 2 accelerates their `INSERT ... SELECT` reads; the envelope/idempotency stays in the app per their decision, untouched here |
| Ops (runtime + Dockerfiles) | `ops/docker-compose.yml` / missing `ops/Dockerfile.node`, `.env.docker` | Site 1 + Site 3 preconditions: runtime decided = Bun (2026-10-30); restoring Dockerfiles pinned to Bun stays an ops-lane ask, not this lane's edit |

Write scope of this lane: `docs/plans/io-uring-optimization-2026-10-30.md` only (plus this plan-lane's own notes). Anything else is out of scope and a defect.

## 6. Deployment gating checklist (run before every io_uring experiment)

1. Kernel: `uname -r` >= 5.1 (host here is 7.3 — fine). io_uring memory locking: kernels < 5.12 need a raised `RLIMIT_MEMLOCK` (mariadb-docker#454 documents `io_uring_queue_init` ENOMEM); 5.12+ relaxed it.
2. Seccomp: in container, `grep Seccomp /proc/self/status` must not show a filter blocking; the blocking errno is EPERM (Docker docs; podman#12671).
3. Postgres 18: `SHOW io_method;` and `pg_config --configure | grep -o liburing`.
4. Bun: `strace -f -e trace=io_uring_setup bun -e 'await Bun.write("/tmp/t", "x")'` shows a ring; then the smoke tests of Site 3.
5. Re-run the two `docs/perf/` scenarios (settlement summary, CSV export) before/after every change and record numbers in `docs/perf/`.

## 7. Risks and fail-safes

- **Seccomp regression** (biggest): shipping Bun/PG18 without Site 1 silently falls back or dies — the first fail-safe check catches it in minutes.
- **PG18 async I/O immaturity**: benchmark `worker` vs `io_uring` per scenario; PG's own operators run conservative defaults initially (Neon note). Full DB upgrade is rolled back via the previous image.
- **Bun native-deps ABI**: smoke-test `argon2` login + `sharp` thumbnail paths under Bun before cutting over; compose already runs Bun, so drift is limited to dev tooling.
- **No-performance-everywhere outcome**: if Site 1+2+3 show no measurable gain on the `docs/perf/` scenarios, stop — the plan is evidence-gated by design and a documented "no" is the correct result (that is what §3's fail-safe checks are for).

## 8. Verified facts and sources (checked 2026-10-30 in-session)

> Method note: the io_uring facts were to be produced by a delegated research run (key `io-facts-2026-10-30`); that run failed twice with an OpenRouter in-flight-credit limit (402) shared with the other lanes, so the facts were researched and cross-checked in this session directly via web search + primary-source fetches. Same evidence standard — every claim above has a URL; no claim in this document was taken on trust from the failed run.

- Docker default seccomp blocks io_uring syscalls: https://docs.docker.com/engine/security/seccomp/ and the profile change https://github.com/moby/moby/pull/46762
- Podman default profile blocks io_uring; CLI flag required, annotation ineffective: https://github.com/containers/podman/issues/12671 ; allowing io_uring in Podman: https://github.com/containers/podman/discussions/27772
- PostgreSQL 18 async I/O, `io_method` (sync/worker), `io_workers`, concurrency defaults: https://neon.com/postgresql/18/asynchronous-io , https://betterstack.com/community/guides/databases/postgresql-asynchronous-io/ , https://aiven.io/blog/exploring-why-postgresql-18-put-asynchronous-io-in-your-database
- PG17 streaming-but-synchronous reads; PG18 AIO footprint (seq scans, COPY, VACUUM, ANALYZE; B-tree/writes/WAL still sync): https://www.credativ.de/en/blog/postgresql-en/postgresql-18-asynchronous-disk-i-o-deep-dive-into-implementation/
- Upstream liburing dependency commit: https://github.com/postgres/postgres/commit/8eadd5c73c44708ecd45b9fd3ac54a550511d16f ; official image liburing support: https://github.com/docker-library/postgres/pull/1366
- PG18 release notes (async I/O): https://www.postgresql.org/docs/18/release-18.html ; io_method setting doc: https://www.postgresql.org/docs/18/runtime-config-resource.html
- Go has no stdlib io_uring: https://github.com/golang/go/issues/31908 , https://github.com/golang/go/issues/57701 ; maintained userland binding status: https://github.com/Iceber/iouring-go
- Bun's Linux io_uring dependence (kernel >= 5.1; memlock): https://github.com/oven-sh/bun/issues/785 , https://github.com/oven-sh/bun/issues/838 ; runtime docs: https://bun.com/docs/runtime
- io_uring memory-lock requirements pre-5.12: https://github.com/MariaDB/mariadb-docker/issues/454

## 9. Open questions (for the orchestrator, not blockers for this document)

1. ~~Runtime: compose says `bun`, but the load test and ops notes say the prod posture is `npx tsx` under Node — which is authoritative today? (Site 3 turns on the answer.)~~ **RESOLVED 2026-10-30: Bun** — `tsx`/Node is legacy dev tooling; align the dev script and any restored Dockerfile on Bun.
2. `ops/Dockerfile.node` / `ops/Dockerfile.go` are referenced by compose but absent — who owns restoring them, and do they pin Bun?
3. ~~Is a PG16->18 major upgrade acceptable in the hackathon window, or should the liburing-built 18 path land post-demo with only Sites 1/3 now?~~ **RESOLVED 2026-10-30: Yes — PG16->18 is possible and accepted in the hackathon window.** Site 2 proceeds as planned (image `postgres:18-alpine` with a benchmark-first `io_method` choice + rollback image via the previous container); it remains its own tracked task per §3 Site 2, so the upgrade ships decided rather than as a chose-not-to-run entry.
