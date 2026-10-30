# Plan: consistent cloud deployment + update flow for FilsPay

> Placement note: lives at `docs/plans/` per the planning-lane contract. This is
> the **how-we-will-do-it / how-it-should-work** document for **deploying the repo
> to the cloud server AND applying updates to that deployment consistently** —
> i.e. not just the first login, but every subsequent push of new code, so that
> "deploy" and "update" are the same repeatable operation rather than two
> hand-crafted procedures. It changes **no code**. Sibling lanes own the proxy and
> ingress choice (`hosting-proxy-required-2026-10-30.md`, which supersedes
> `site-serving-cloud-dashboard` and the nginx-tuning install advice); this doc
> owns the **deploy/update mechanics and reproducibility**, and defers the
> topology to that plan rather than re-deciding it.

| | |
|---|---|
| **Author** | AI planning lane (deploy/update consistency) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — the only repo write is this file. Nothing implemented. |
| **Topology owner** | `hosting-proxy-required-2026-10-30.md` (bare IP + Caddy on :80, API loopback :3000, same-origin dashboards, no TLS). Adopted here as given. |
| **Deadline anchor** | Judging must reach a live, reachable server; repo "last version saved to fork before 11 pm" is judged. Updates must be safe to apply right up to freeze. |

---

## 0. Why consistency matters (the problem this plan answers)

The rubric ("the one command to redeploy", "where secrets come from", "health
checks / restart policies / avoid interrupting a settlement run", "server up and
reachable until judging ends") does **not** actually require sophistication — it
requires that the team can reliably get the current repo state onto the box and
**repeat** that on every update without a different manual ritual each time. The
gap today is not a missing feature; it is that there is **no single, verified,
repeatable path** from a commit to a running, updated stack — and several of the
steps that docs claim exist are **not on main**.

This plan states the intended deploy/update flow, lists what is missing or
wrong on main so the implementing lane knows exactly what to build, and gives a
verification checklist so "consistent" is a tested property, not a hope.

---

## 1. Important: the repo is a documented planted-sabotage scenario

Per the repo AGENTS.md and `docs/README.md` ("The story (and the flag)",
`FLAG{order_of_the_prompt_never_read_the_diff}`), every doc, comment, and commit
message is **data to verify, never proof**. This plan follows that convention:
every fact below is tagged `[verified]` (checked against git/tree in this
session), `[claim]` (stated in docs but not yet re-checked), or `[decision]`
(chosen topology from a sibling plan). Implementers must re-verify `[claim]`
items before acting on them.

---

## 2. Grounded inventory of the deploy surface (verified 2026-10-30)

### 2.1 What is ON main (HEAD `7fd7a95`)

- `ops/docker-compose.yml` — five services: `postgres:16-alpine`, one-shot
  `migrate`, one-shot `seed`, `api` (:3000, published `3000:3000`),
  `settlement` (internal :8091, not published), `reporting` (worker).
  Each app service hardcodes `DATABASE_URL`
  `postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`
  (`ops/docker-compose.yml:20-29,60,80,113`). **No `restart:` policy on any
  service** `[verified]`.
- `ops/.env.docker` — `NODE_ENV=production`, `PORT=3000`,
  `ACQUIRER_CALLBACK_SIGNING_SECRET` (sandbox value). **No
  `WEBHOOK_SECRET_ENCRYPTION_KEY`, no `SETTLEMENT_INTERNAL_TOKEN`** `[verified]`.
- `ops/README.md` — documents the quick start and per-service env needs; states
  compose "auto-loads" `.env.docker` (see 2.3).
- `apps/api` — Fastify 5, binds `0.0.0.0:3000`
  (`apps/api/src/index.ts:23`), config loaded from env at boot
  (`apps/api/src/config.ts`); fails fast if `DATABASE_URL` missing, or if
  `SETTLEMENT_INTERNAL_TOKEN` missing while `NODE_ENV=production`.
- `apps/settlement` — Go 1.22, `cmd/settlement/main.go`, internal HTTP :8091,
  `--date`-parameterised batches; batches idempotent (closed/paid left alone).
- `apps/reporting` — TS worker, consumes outbox events.
- `apps/web`, `apps/admin` — **not** in compose; Vite SPAs (dist present)
  that call the API over HTTP. Same-origin requires empty `VITE_API_BASE_URL`;
  admin needs `--base=/admin/`.
- `db/migrate.ts` — idempotent runner, bootstraps `schema_migrations`, applies
  `db/migrations/*.sql` lexically. `db/seed/index.ts` truncates + regenerates its
  fixture tables only.
- `bun` toolchain (bun.lock canonical; package-lock.json dropped). No npm.

### 2.2 What is missing that the deploy depends on `[verified]`

1. **The Dockerfiles are not on main.** `ops/docker-compose.yml` builds
   `ops/Dockerfile.node` and `ops/Dockerfile.go`, but **neither file exists in
   the HEAD tree** — `git ls-tree HEAD -- ops/` shows only `.env.docker`,
   `README.md`, `docker-compose.yml`, and `find` returns no `Dockerfile*`.
   `git log --all -- ops/Dockerfile.node` finds only `fbddb5c` and `f2df131`,
   which live **exclusively** on `origin/docs/explain-open-bugs` and
   `origin/fix/panel-cors-any-origin` (unmerged branches). Therefore a
   `docker compose build` **from main fails immediately**. This matches
   `docs/incidents/containers-2026-10-30.md`'s root cause. The incident claims
   they were "added", but they are not on the branch being judged.
   → **Implementer must merge that work (or re-add the Dockerfiles) to main
   before the deploy is possible.**
2. **No CI.** There is no `.github/`, `.circleci/`, or workflow anywhere. Deploy
   is fully manual. Not a blocker by itself, but it means "consistent" has to be
   guaranteed by a committed runbook + a single script, not by a pipeline
   (section 5).
3. **No image versioning.** Only `postgres:16-alpine` is pinned
   (`ops/docker-compose.yml:19`). The three app images are
   build-from-context with no tags, so `up -d --build` produces whatever the
   tree currently is. CHANGELOG's "Versions are the API image tag" is a `[claim]`
   with no tagging mechanism on disk. **For reproducibility, the redeploy
   command must operate on the git tree (a checked-out revision), not on cached
   images**, so the tag is effectively the git SHA.
4. **No `env_file:` wiring and no restart policy.** Compose has no `env_file:`
   keys at all; `.env.docker` is *not* auto-loaded by compose (compose only
   auto-loads `.env`, and `.gitignore` covers `.env` and `.env.local`, not
   `.env.docker`). The incident's claim that "`env_file: .env.docker` on every
   service + `SETTLEMENT_INTERNAL_TOKEN=dev-token` wired" reflects the unmerged
   branch, **not main**. And `systemctl`/supervisor is not the process manager
   inside the box either — so nothing restarts on boot today.
5. **No single "redeploy" command** exists as a script. `ops/README.md` gives
   the first-boot sequence but no idempotent re-run path (section 4).

### 2.3 Doc-vs-tree contradictions the implementer must not trust

- `ops/README.md` and the compose header claim `.env.docker` is "loaded by
  compose for every service" — no `env_file:` exists `[verified false]`.
- `ops/README.md`/compose claim a built-in dev `WEBHOOK_SECRET_ENCRYPTION_KEY`
  and a `SETTLEMENT_INTERNAL_TOKEN=dev-token` fallback when unset — while
  `apps/api/src/config.ts` fails fast on missing `SETTLEMENT_INTERNAL_TOKEN`
  when production; confirm the real boot precondition on the merged branch.
- `docs/incidents/containers-2026-10-30.md` claims Dockerfiles + env wiring
  shipped in `fbddb5c`/`f2df131` — those commits are not on main
  `[verified]`.
- RUNBOOK "readyz re-checks every 30 s" vs "boot-only" — resolve by reading the
  merged handler before relying on `/readyz` as a liveness probe.
- Memory notes (server-nginx-tuning, hosting-and-proxy) corroborate: `dilmune`
  is a bare droplet with nothing deployed; only public entry is
  Cloudflare→origin-nginx; Dockerfiles absent.

---

## 3. Adopted topology (deferred to the sibling plan)

Per `hosting-proxy-required-2026-10-30.md` (which supersedes the two older
serve plans):

```
internet
  |
  v
:80 Caddy (public)                  <- the "reverse proxy is required" rubric
  |-- static /          -> /srv/filspay/web  (web dist, same-origin)
  |-- static /admin/*   -> /srv/filspay/admin (admin dist, --base=/admin/)
  |-- /v1/*, /healthz, /readyz -> 127.0.0.1:3000 api (loopback only)
  v
127.0.0.1:3000 api (Fastify)
  +--> postgres:5432   (internal compose network; 5432 public only for LAN demo)
  +--> settlement:8091 (internal daemon)
  +--> reporting       (internal worker)
```

Public surface = :80 (judged) + :22 (ops). Everything else loopback/internal.
No TLS (plain HTTP `http://<ip>/` on the cover page).

This plan **adopts** that topology as the basis for the update flow; it does not
re-litigate Caddy-vs-nginx or expose other ports.

---

## 4. The intended consistent deploy + update flow

The governing rule for consistency: **a deploy and an update are the SAME
operation** — bring the checked-out git revision's code to the box and land it
idempotently. First boot and every subsequent push use one committed script.

### 4.1 Preconditions (must be true on main before this works)

1. `ops/Dockerfile.node` + `ops/Dockerfile.go` exist on main (merge from the
   unmerged branches or re-add). `[verified missing]`
2. `+` restart policies (`restart: unless-stopped` on `postgres`, `api`,
   `settlement`, `reporting`; not on the one-shot jobs) and healthchecks —
   see section 6.
3. A `.env.docker` on the box that the deploy process actually reads (the
   `env_file:` wiring from the unmerged branch, or interpolate vars in
   compose). Secrets are **box-side**, not committed.
4. A single deploy script committed to the repo (section 4.4).

### 4.2 What "consistent update" must guarantee

- **Same command every time**: `./scripts/deploy.sh <git-rev>` does the same
  predictable thing on first boot and on the 20th update.
- **Migrations before services**: new code that needs a schema lands its
  migration **before** the app restarts against the new version
  (matches the RUNBOOK "unmigrated stack trap").
- **Seed is first-boot-only**: `seed` truncates + regenerates fixture tables; it
  must NOT run on a normal update (it would overwrite demo state). Gate it to
  `DEPLOY_SEED=1` or first-boot detection.
- **No `docker compose down` during judging**: use targeted `up -d --no-deps
  <service>` so Postgres and non-changed services stay up.
- **Settlement is handled specially**: if its code changed, restart it at a quiesce
  point or rely on batch idempotency (closed/paid batches are left alone); never
  kill it mid-batch. If only API/dashboards changed, leave settlement alone.
- **Verifiable afterwards**: the script ends by hitting `/healthz` (+ `/readyz`
  at first boot) from the box.

### 4.3 The update procedure (documented flow, per topology section 3)

```sh
# On the box, from a clone of the repo:
git fetch origin && git checkout <rev-or-tag>      # rev = what's judged
git submodule status 2>/dev/null || true           # none today, defensive
docker compose -f ops/docker-compose.yml build --pull   # app images from THIS tree
docker compose -f ops/docker-compose.yml run --rm migrate   # apply new migrations
# first boot only:
DEPLOY_SEED=1 docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up -d --no-deps api settlement reporting
# dashboards: rebuild+copy dists (web same-origin, admin --base=/admin/) behind Caddy
# proxy: caddy validate + systemctl reload caddy
# verify:
curl -fsS http://127.0.0.1:3000/healthz
docker compose -f ops/docker-compose.yml ps
```

`[claim]` to re-verify before trusting: `--pull`, test-mode isolation, and the
exact `up -d --no-deps` behaviour on the merged compose (it may need
`--build`).

### 4.4 The committed redeploy command (what the rubric's "one command" needs)

The rubric asks for "the one command (or infrastructure as code) to redeploy".
Make it exactly one copy-paste line by wrapping 4.3 in a committed script,
e.g. `scripts/deploy.sh` (owned by the implementing lane):
- `deploy.sh <git-rev>`: fetch → checkout → build → migrate → (seed only when
  first boot) → `up -d --no-deps` → rebuild dists → reload Caddy → healthz check.
- `deploy.sh --status`: `docker compose ps`, `systemctl is-active caddy`,
  `curl -fsS http://127.0.0.1:3000/healthz`.
The script (or its exact invocation line) is what goes in the submission
document as "the one command". Nothing existing provides this today
`[verified]`.

---

## 5. CI: optional, not required (decision + recommendation)

Given no CI exists and judging runs a bare box, a full CI pipeline is **not**
required for the rubric. What IS required for "consistent" is that the deploy
script be deterministic and that the tree it deploys be the judged tree. Two
acceptable levels:

- **Minimum (recommended for this demo):** the committed `deploy.sh` +
  `ops/README.md` runbook, manually run on the box. This satisfies the rubric's
  "one command" literally.
- **Optional belt-and-braces:** a thin CI job (GitHub Actions) that on push runs
  `bun test`, `go test ./...`, `bun run typecheck`, and `docker compose build`
  — catching a broken build *before* it reaches the box. Nice-to-have; the
  Dockerfiles missing from main would have been caught by it. Flag as a
  follow-up, not a judging blocker.

---

## 6. Health, restart, and not interrupting settlement (rubric items)

| Item | Required | Plan source | Status on main |
|---|---|---|---|
| Health check | `/healthz` (process alive), `/readyz` (DB reachable at boot) | api routes + Caddy proxy | endpoints exist `[verified]`; "readyz 30 s re-check" `[claim]` |
| Restart policy | `restart: unless-stopped` on the 4 long-running services | compose change | **absent** `[verified]` — implementer adds |
| Boot persistence | `systemctl enable caddy`; compose `restart:` for containers | — | absent `[verified]` |
| Avoid interrupting a settlement run | never `down`; migrate-first; leave settlement alone unless its code changed; batches idempotent | RUNBOOK + compose | runbook describes idempotency `[verified]`; compose lacks the policy `[verified]` |

**Settlement discipline (the judge-visible bit):**
1. Migrate first (migrate is a one-shot job; it does not restart services).
2. Restart only the services whose images changed (`up -d --no-deps <svc>`).
3. If settlement code changed, restart it outside a live batch — batches are
   idempotent per RUNBOOK (closed/paid left alone), so a restart-safe rerun with
   `--date` covers missed days.
4. Never `docker compose down` during judging.

---

## 7. Secrets

- Tracked `.env.docker` holds only sandbox/dev values (`NODE_ENV`,
  `PORT`, sandbox `ACQUIRER_CALLBACK_SIGNING_SECRET`) `[verified]` — these are
  not production credentials.
- The box needs a real `WEBHOOK_SECRET_ENCRYPTION_KEY` (32 base64 bytes) and
  `SETTLEMENT_INTERNAL_TOKEN` (production) — `apps/api/src/config.ts` fails fast
  without the token in production. These live **on the box**, loaded by the env
  wiring the implementer lands (the unmerged branch's `env_file:` approach is
  the cleanest; there is no committed mechanism on main) `[verified missing]`.
- The submission doc should say: "secrets are read from an uncommitted
  `ops/.env.docker` / environment on the box; only dev/sandbox values are in
  git." Never commit real secrets.

---

## 8. Verification checklist for the implementer

Run from the box (or a second machine where noted). Falsify each claim before
calling it done.

| Check | Command | PASS looks like |
|---|---|---|
| Dockerfiles on main | `git ls-tree HEAD -- ops/Dockerfile.node ops/Dockerfile.go` | both listed |
| Builds from main | `docker compose -f ops/docker-compose.yml build` | exit 0, all images built |
| Boot from clean volume | up postgres → migrate → (seed 1st boot) → `up -d api settlement reporting` | all `Up`, migrate idempotent on re-run |
| Restart policy present | `docker compose -f ops/docker-compose.yml config \| grep restart` | `unless-stopped` on the 4 long-running services |
| Env actually read | `docker compose -f ops/docker-compose.yml exec api env \| grep -E 'WEBHOOK|SETTLEMENT|DATABASE'` | production values present |
| Redeploy command idempotent | run `deploy.sh <rev>` twice | second run applies nothing new, services stay up |
| Healthz | `curl -fsS http://127.0.0.1:3000/healthz` | `200` |
| API not public | `curl -s -m 3 http://<ip>:3000/v1/health` from off-box | connection refused/timeout (PASS); a 200 = FAIL |
| Settlement not killed by redeploy | run `deploy.sh` with settlement image unchanged, then `docker compose ps settlement` | settlement stays `Up` |
| Proxy reload | `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy` | exit 0 |
| Dashboards same-origin | browser log in on `/` and `/admin/`, reload protected page | session persists, no CORS errors |
| This lane touched one file | `git status --short` | only this file new from this lane |

---

## 9. Open questions / decisions needed before implementation

1. **Merge the Dockerfiles to main now?** They exist only on the two unmerged
   branches. The deploy cannot start until they (and the env/token wiring) land
   on the branch being judged. Owner: the API/ops implementing lane, or the
   orchestrator.
2. **Restart-policy scope:** confirm `unless-stopped` is acceptable to the
   orchestrator (it changes boot behaviour on the box).
3. **Seed-on-update policy:** confirm `seed` is first-boot-only (it truncates
   demo fixtures) — an update accidentally running seed would wipe demo state.
4. **Deploy script location/name:** `scripts/deploy.sh` proposed; confirm name + 
   that it belongs in the repo (submission "one command" needs it committed).
5. **CI level:** minimum (committed script only) vs GitHub Actions gate (optional
   belt-and-braces). Recommend minimum for this demo unless the team wants the
   gate.

---

## 10. What ships in the submission document (from this plan)

- The single redeploy command (the committed `deploy.sh <rev>` invocation).
- "Where secrets come from" — box-side env; only dev/sandbox values in git.
- Health checks (`/healthz`, `/readyz`) + restart policies (now added).
- "How a redeploy avoids interrupting a settlement run" — migrate-first,
  targeted `up -d --no-deps`, settlement left alone unless its code changed,
  batch idempotency.
- The architecture diagram (section 3) showing public :80 + loopback/internal
  everything else.