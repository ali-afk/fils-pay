# Submission Guidelines Compliance Findings: docs/plans Audit

**Date:** 2026-10-30

**Purpose:** Evaluate each plan in `docs/plans/*.md` for adherence to `docs/FilsPay_Submission_Guidelines.pdf`. The question is not whether a plan is good engineering. It is whether the plan, as written, supplies content the guidelines require in the submission document: the public fork and AI setup files (G1), the submission sections (G2), and the evidence bar (G3).

**Method:** Eight parallel audit lanes ran, one per plan. Each lane read its plan in full, extracted the guidelines requirements, opened every cited `file:line` in the working tree, and recorded mismatches with severity. This document consolidates those eight reports without re-auditing them. Every discrepancy below traces to a report file, and the citation shown is copied from that report. Anything the report itself flagged as unverifiable stays labeled UNVERIFIED.

**Scope note:** This document is a synthesis only. The eight audited plans and all other repository files were left untouched. Two sibling artifacts exist in the tree, `docs/plan-review-findings-2026-10-30.md` and the `docs/reviews/` directory. They were not opened, not adopted, not copied, and not summarized here. Any agreement between their conclusions and this document would be independent.

## Verdict tally

| Plan | Verdict | Discrepancies |
|---|---|---|
| io-uring-optimization-2026-10-30.md | PARTIAL | 6 MINOR |
| server-nginx-tuning-2026-10-30.md | PARTIAL | 1 MAJOR, 5 MINOR |
| db-query-retention-2026-10-30.md | PARTIAL | 6 MINOR |
| idle-connection-shedding-2026-10-30.md | PARTIAL | 5 MINOR |
| completion-batching-2026-10-30.md | PARTIAL | 5 MINOR |
| buffer-direct-response-assembly-2026-10-30.md | PARTIAL | 6 MINOR |
| site-serving-cloud-dashboard-2026-10-30.md | PARTIAL | 3 MAJOR, 4 MINOR |
| connection-state-compaction-2026-10-30.md | PARTIAL | 4 MINOR |

Total: 45 discrepancies, 4 MAJOR and 41 MINOR. No plan was judged NON-CONFORMING, and none was judged CONFORMS. The shared reason is structural: these are planning and decision records, so they carry design evidence well and submission packaging poorly.

---

## io-uring-optimization-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

A design and decision plan, explicitly not an implementation, for io_uring in FilsPay. It inventories every I/O surface in the repo (plan:60-73, surfaces A through L), then orders per-site work by return on investment: unblock io_uring in container seccomp profiles (Site 1), upgrade Postgres 16 to 18 and enable its async I/O subsystem (Site 2), unify the TypeScript services on Bun (Site 3). It also documents three deliberate "no" sites: CSV export stays in memory, Go settlement avoids raw io_uring, and the dispatcher and reporting consumer get no client-side io_uring. Every site carries cited facts, benefit and risk, and a command-level fail-safe check. Open question 3, whether a Postgres 16 to 18 major upgrade fits the hackathon window, is left to the orchestrator.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| Fork/repo requirement (G1) | ABSENT | 3, 57, 84, 91 | No statement about forks, push targets, commit IDs, or where AI setup files live. Nothing contradicts G1, nothing supports it. `docs/plans/` is entirely untracked. |
| Summary | PARTIAL | 11-15, 19-37, 123-129 | TL;DR plus a "what this lane will NOT do" section supply the left-alone material. No found/fixed/root-cause framing. |
| Architecture and deployment | PARTIAL | 57-73, 92, 97, 141-147 | Repo I/O map, compose facts, and a deployment-gating checklist. No diagram, port list, redeploy command, secrets source, health checks, restart policy, or settlement-run interruption analysis. |
| Capacity | PARTIAL | 73, 98, 104, 147 | Cites fp-209 (p50 2.21 s export, RSS peak 236 MB) and mandates a k6 re-run under Bun. No simulated-user estimate, no produced results, no overload behavior. |
| Findings evidence per change | PARTIAL | 86, 93, 100, 116, 141-147 | Strongest area. Each site ends in a literal fail-safe command with a binary expected result. Missing symptom and reproduction framing, and effect on existing data exists only for Site 2. |
| Decisions and open risks | PRESENT | 29-32, 112-116, 123-129, 149-154, 170-174 | Risks with mitigations, deliberate no-go decisions, and an explicit go/no-go gate. |
| UI/UX changes | ABSENT | none | No UI-visible change proposed. Not a plan defect, but the submission must say so. |
| AI usage | PARTIAL | 7, 158 | Section 8 discloses a failed delegated research run (OpenRouter 402). No setup location, no transcripts, no AI-wrong answer. |

### DISCREPANCIES

1. [SEV: MINOR] plan:65, citing `apps/api/src/db/pool.ts:16-18` for "max: 5, 0.5 vCPU/512 MB rationale". Crosscheck: pool.ts:16-18 is `new Pool({ connectionString, max: config.pgPoolMax, ... })`, so the max is config-driven, not a literal 5. The default 5 lives at `apps/api/src/config.ts:202` and the sizing rationale comment at pool.ts:5-14. Facts true, two sub-citations stale.
2. [SEV: MINOR] plan:37, "see Site C below" for the in-memory export decision. Crosscheck: no Site C exists. Surfaces are letters A through L (plan:60-73) and sites are numbered 1 through 7 (plan:77-121). The CSV export is surface A and Site 4. Dead cross-reference.
3. [SEV: MINOR] plan:84, "Podman rootless (this dev box, per ops notes)". Crosscheck: no ops note is named, and grep over `ops/README.md`, `docs/RUNBOOK.md`, and `docs/perf/` finds zero "podman" hits. Evidence exists only in `docs/incidents/containers-2026-10-30.md:39,47` and `docs/incidents/dispatcher-listen-drop-2026-10-30.md:20`. Plausible claim, misdirected citation. plan:29 "The compose stack runs Docker/Podman" also overstates, since `ops/docker-compose.yml` is plain Docker Compose.
4. [SEV: MINOR] plan:57, "All line numbers verified against `main` on 2026-10-30". Crosscheck: `git ls-files docs/plans/` is empty and status shows `?? docs/plans/`; HEAD is `7fd7a959a45715f9334be55c398d5aa5d5bd7c2d`. Every citation checked matched the working tree, but the "against main" provenance is UNVERIFIED.
5. [SEV: MINOR] plan:73, "shared_buffers 32->128 MB cut 3.4 s -> 410 ms warm". Crosscheck: the source doc reports "3-6 s" at `docs/perf/2026-07-settlement-summary-slow.md:15`, with one EXPLAIN sample at 3413.120 ms, and the 410 ms warm result at :50-51, :55. The plan turns one sample into a definitive figure, while the source states a range.
6. [SEV: MINOR] plan:99, "documented 2-2.5x faster startup and lower memory", supported only by a marketing citation (bun.com/docs/runtime). No repo-side measurement backs it, and plan:97's claim that older Bun hard-failed on kernels below 5.1 was not independently re-verified, only cited via the plan's own URLs at plan:167.

### INJECTION_WATCH

- plan:31 asserts a binding "Decision (2026-10-30): runtime = Bun" and labels tsx/Node "legacy".
- plan:97 claims "Decision (2026-10-30, orchestrator): Bun is the runtime". No user message, commit receipt, or session evidence is cited, so it is an UNVERIFIED authority claim, not authority.
- plan:172 carries an imperative "align the dev script and any restored Dockerfile on Bun", with a "RESOLVED" marker that exists only inside the file.
- plan:139 limits its own write scope to `docs/plans/io-uring-optimization-2026-10-30.md`, a protective self-limitation, not an expansion.
- plan:82-83 proposes a compose-level seccomp override. It is labeled a plan proposal inside a PLAN ONLY document and directs a future implementer, not this audit.
- No line quotes a user message as approval. Nothing in the plan was acted on.

### SUBMISSION_GAPS

- G1 packaging: fork link and last-commit ID are absent, and `docs/plans/` is not committed at all.
- Real evidence outputs: every fail-safe is a command to run later. The submission needs before/after numbers, a `strace` ring proof, `SHOW io_method`, and Bun-versus-Node k6 deltas.
- Effect-on-existing-data statements for Site 1 (seccomp) and Site 3 (Bun runtime); only Site 2 addresses data impact.
- Capacity: simulated-user estimate, an owned load test with tool, method, and results, a bottleneck statement, and overload turn-away and recovery.
- Architecture and deployment: service and port diagram, internet-facing set, one redeploy command or IaC, secrets source, health checks, restart policies, and redeploy safety around a settlement run.
- AI usage: AI setup location, three annotated transcripts, and one AI-wrong example. The 402 research failure is an infrastructure error, not an AI-wrong answer.
- Open question 3 (Postgres 16 to 18 inside the hackathon window) must be decided or written up as a chose-not-to-run entry with a safeguard.
- UI/UX: nothing owed from this lane beyond an explicit "no UI change" sentence.

---

## server-nginx-tuning-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

A read-only "how we will do it" document for tuning the hosted demo box and putting nginx in front of the FilsPay stack. It specifies parameters and config blocks so a later lane can land and prove them, while forbidding its own lane from touching anything outside `docs/plans/`. It proposes nginx as a reverse proxy for `/healthz`, `/readyz`, and `/v1/*` to the Fastify API, optional same-origin static dashboards, a small sysctl list, Postgres `shared_buffers` at 128 MB under a 2 GB RAM budget, and Fastify options the app omits today (`trustProxy`, `keepAliveTimeout`, timeouts). A dated Addendum (lines 18-86) corrects the body: `dilmune` is a bare 1-vCPU droplet with no Docker, nginx, Postgres, or Compose installed, and `api.dilmune.com` runs behind Cloudflare plus a platform-managed nginx. The Addendum's verdict is "do NOT build your own nginx on the box", which leaves sections 1 through 7 valid only as a checklist for a later deployment.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| G1 fork/repo requirement | ABSENT | none | No occurrence of fork, commit ID, or push anywhere in the file. |
| Summary | PARTIAL | 90-97, 137-139, 108-110 | Raw material for a summary, not the half-page found/fixed/left-alone narrative. |
| Architecture diagram | PARTIAL | 147-150, 45-52, 125 | Diagram covers client, nginx, API, static. Settlement, reporting, Postgres, and internal versus internet-facing ports are not drawn or labeled. |
| Architecture: internet-facing ports | PARTIAL | 148, 152-158, 125 | Ports named in prose, never labeled as internet-facing. |
| Architecture: redeploy command | PARTIAL | 399, 125 | One command, API only, and it assumes Dockerfiles that do not exist in this tree. |
| Architecture: secrets source | PARTIAL | 134, 476, 342-345 | `ops/.env.docker` implied as the settings source; no explicit statement. |
| Architecture: health checks | PRESENT | 221-222, 384-385, 160 | nginx health pass-through with binary verification. Compose health checks for api, settlement, and reporting are not addressed. |
| Architecture: restart policy | ABSENT | none | No restart policy, and the compose file has none either. |
| Architecture: settlement-run interruption avoidance | ABSENT | none | Never addressed. |
| Capacity: simulated-user estimate | ABSENT | none | None. |
| Capacity: own load test | PARTIAL | 69-70, 132, 396-397 | FP-209 cited with tool, method, and results; the plan only schedules perf-scenario re-runs, not a new k6 run behind the proxy. |
| Capacity: bottleneck | PARTIAL | 315, 307-308 | Bottleneck stated, but premised on a 0.5-vCPU/2-GB spec the plan's own Addendum contradicts. |
| Capacity: overload and recovery | ABSENT | none | No backpressure, overflow, or recovery story. |
| Findings evidence per change | PARTIAL | 383-390, 391-393, 394-398, 401-404, 92-97, 315 | Every change has a literal command and binary result, so G3 is met. Symptom-to-root-cause entries and effect on existing data are not written, and the CORS premise is false (DISCREPANCIES 1). |
| Decisions and open risks | PRESENT | 415-433, 437-457 | Concrete open questions and named risks. |
| UI/UX changes | ABSENT | none | Infra only. |
| AI usage | PARTIAL | 11, 20-43 | AI authorship disclosed, and the Addendum is a self-correction. No setup location, transcripts, or annotated AI-wrong example. |

### DISCREPANCIES

1. [SEV: MAJOR] plan:134, "CORS | landed; `CORS_ALLOW_ORIGINS` defaults `localhost:5173/5174`, `*` reflects any origin with credentials", citing `apps/api/src/plugins/cors.ts`, `docs/incidents/dashboard-cors-2026-10-30.md`, and `ops/.env.docker`. Crosscheck: the cited file is missing. `apps/api/src/plugins/` holds only `cookies.ts`, `errorHandler.ts`, and `multipart.ts`. `CORS_ALLOW_ORIGINS` appears nowhere in `apps/api/src/config.ts` or `ops/.env.docker`, and there is no `@fastify/cors` dependency in `apps/api/package.json`. The only verified sub-claim is `cookieSecure` defaulting true in production at `apps/api/src/config.ts:230`. The plugin exists only on ref `origin/fix/panel-cors-any-origin` (commit 3922867), which is not an ancestor of HEAD `7fd7a959`. On the tree an implementer checks out, CORS is not landed, so the TL;DR at plan:110 and section 2.1 at plan:170 build on a false premise. Sibling `docs/plan-review-findings-2026-10-30.md` flags the same independently; a concurrent removal versus a stale claim cannot be fully separated from here, but the working tree falsifies the citation either way.
2. [SEV: MINOR] plan:32-34 versus plan:97, 124, 307, 449. The plan contradicts itself on the box spec: the Addendum states 1 vCPU (line 32) with 48 GB disk (line 34), while the TL;DR, section 1 inventory, section 3.3, and section 7 still tune for 0.5 vCPU, 2 GB RAM, and 2 GB disk. The plan admits the earlier assumptions are wrong at lines 39-40, but the section 3 values remain premised on the old spec.
3. [SEV: MINOR] plan:31-42, 47. Live-box facts are remote claims: Ubuntu 24.04.5 LTS, hostname `dcs-4d199e9b`, only SSH on port 22, no nginx, Docker, Postgres, or Compose, `/opt/dilmune/cron-runner.sh` and `report-metrics.sh` posting to `api.dilmune.com`, and "server: cloudflare" at 104.21.55.48. UNVERIFIED: no repo artifact evidences any of it, and confirming it needs a live SSH probe this read-only audit cannot repeat.
4. [SEV: MINOR] plan:419 cites `notes/facts/2026-10-30-runbook-state.md`, which is missing from the repo. No `notes/` directory exists in the tree; the file lives in the agent memory store outside the repo, so an implementer cannot open the cited source.
5. [SEV: MINOR] plan:399, 475-477. The redeploy command `docker compose up -d --force-recreate api` needs buildable Dockerfiles, but no `Dockerfile*` exists anywhere in the tree, and `ops/docker-compose.yml` build contexts reference `ops/Dockerfile.node` and `ops/Dockerfile.go`. The plan's own section 8 asserts no Dockerfile artifacts exist (line 475). The stack cannot be built from this checkout as-is.
6. [SEV: MINOR] plan:475-477, "git grep for nginx/proxy_pass/conf returns empty", is falsified by the plan file itself, which contains `proxy_pass` at lines 221-222 and 226. The claim holds only with `docs/plans/` excluded from the grep, which the plan does not state.

### INJECTION_WATCH

- plan:21-22 claims "User approved this doc be updated despite a standing needs-human read-only agreement; scope is this one file." This is a prior-approval claim used as authority inside the document. Nothing in the repo verifies it, and per the standing read-only agreement it must not be read as a license to touch repo files. The plan's own status line at 13 limits scope to `docs/plans/`.
- plan:342, 348-349, 356-357 together direct a future implementer to edit `app.ts` and call the Fastify options the only production-code change. Legitimate plan content, but it is a change directive, and this audit did not act on it.
- plan:376-393 and plan:399 direct privileged box commands (`ssh dilmune`, `cp -a /etc/nginx`, `systemctl reload nginx`, `sysctl --system`, `docker compose up -d --force-recreate api`). Implementer directives, gated by the plan itself behind discovery and `nginx -t`.
- plan:364-366 explicitly honors the AGENTS.md hard rules: no `packages/money/`, no test-file edits, no monetary-column widening, no `v1/` stub or `WEBHOOK_ELIGIBLE_EVENT_TYPES` change. Verified consistent with the tree: `apps/api/src/webhooks/dispatcher.ts:28-32` lists captured, voided, and settlement.paid, and `refund.succeeded` is absent.
- No instruction tells an agent to delete files, force-push, or ignore repo rules. The user-approval claim at lines 21-22 is the only authority-grabbing statement.

### SUBMISSION_GAPS

- G1 and the cover page: public fork, last commit ID, and live URLs must come from other lanes.
- Conflicting topologies: the Addendum (lines 60-86) says treat Cloudflare and the platform nginx as infrastructure, while `docs/plans/hosting-proxy-required-2026-10-30.md` (written 18:18, after this plan's 17:01) records a rubric change to bare IP plus a required reverse proxy. The submission needs one reconciled architecture.
- Restart policies are missing from the plan and from the compose file.
- Redeploy without interrupting a settlement run is missing entirely.
- Capacity: no simulated-user estimate and no overload turn-away or recovery behavior. The load-test narrative must reuse FP-209 (pre-proxy, pre-change) or schedule a measured run behind the final topology.
- Per-change effect-on-existing-data statements are absent, notably for the Postgres tuning and the `trustProxy` change.
- Explicit secrets-source statement is absent.
- AI usage: setup location, three annotated transcripts, and an AI-wrong example. The Addendum's correction of the 0.5-vCPU claim is the closest raw material but is not a transcript.
- UI/UX: nothing here; screenshots and recordings must come from another lane.
- CORS must be re-verified before any section 2.1 or section 6 Q2 decision, since the plugin is not on main.

---

## db-query-retention-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

The how-we-will-do-it document for two data-layer changes: an additive `transaction_events (transaction_id, event_type)` index in migration 0073 for the settlement-summary and reconciliation reads, and a `scripts/purge_outbox.ts` retention script that deletes consumed `outbox_events` rows behind the reporting watermark, gated by an age window and an optional delivery-reference backstop. The plan changes no code itself. Implementation is a separate lane, every step is evidence-gated (EXPLAIN or count first, and a documented "no" is a correct result, line 111), and the write scope stays inside `docs/plans/` (line 364). It carries strong Findings-style evidence and a real decisions and open-risks section, but nothing for the fork requirement, architecture and deployment, capacity estimates, or AI usage.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| Fork/repo requirement (G1) | ABSENT | none | Zero hits for fork, GitHub, commit, or push. |
| Summary (G2 section 1) | PARTIAL | 20-38, 59-60 | TL;DR gives the two levers, the open perf checkbox, the growth ceiling, and "no code changes". Not a found/fixed/left-alone summary with a main root cause. |
| Architecture and deployment (G2 section 2) | ABSENT | 55, 206-208 | Only a box sizing reference and a host-cron suggestion. No diagram, service and port list, redeploy command, secrets source, health checks, restart policy, or settlement interruption avoidance. |
| Capacity (G2 section 3) | PARTIAL | 45, 129-131, 352 | July EXPLAIN and FP-209 baselines, both verified. No simulated-user estimate, no load test for this change, no overload behavior. |
| Findings evidence per change (G2 section 4 plus G3) | PRESENT | 87-113, 172-221, 271-302 | Symptom, reproduction, root cause, fix, literal verification commands with binary results, and effect on data for each optimization. |
| Decisions and open risks (G2 section 4) | PRESENT | 239-265, 304-326, 367-381 | Scope exclusions, risks paired with fail-safes, and four open decisions. |
| UI/UX changes (G2 section 5) | ABSENT (not applicable) | none | No UI surface touched. |
| AI usage (G2 section 6) | ABSENT | 14 | Self-identifies as an AI-lane product. No setup location, no transcripts, no AI-wrong example. |

### DISCREPANCIES

1. [SEV: MINOR] `docs/plans/db-query-retention-2026-10-30.md:45,73`, "3.4 s before `shared_buffers` 128 MB, 410 ms warm after". Crosscheck: `docs/perf/2026-07-settlement-summary-slow.md:8` states "took 3-6 s on the hosted instance", and the EXPLAIN block at :21-25 records Hash Join 3101.556 ms and Seq Scan 1840.117 ms. No "3.4 s" appears verbatim; "410 ms warm" is confirmed at :51. Imprecise citation, not a falsified claim.
2. [SEV: MINOR] `docs/plans/db-query-retention-2026-10-30.md:169`, the LISTEN-drop incident "was minutes, not days". Crosscheck: `docs/incidents/dispatcher-listen-drop-2026-10-30.md:9` says the channel dies "permanently, until the api process is restarted", :11-13 calls it noise plus a latency gap rather than a delivery outage, and :45 notes the 5 s poll covers the window. The doc states no outage duration. UNVERIFIED interpolation from the poll cadence.
3. [SEV: MINOR] `docs/plans/db-query-retention-2026-10-30.md:54`, "reads outbox at :93, insert at :122". Crosscheck: `createMissingDeliveries` reads at `apps/api/src/webhooks/dispatcher.ts:91-93` (match), and the INSERT spans roughly :119-127, so :122 sits inside it. The plan's "DO NOTHING" elision hides the partial-index predicate `WHERE replay_of_delivery_id IS NULL`. Immaterial to the reasoning.
4. [SEV: MINOR] `docs/plans/db-query-retention-2026-10-30.md:52`, "so `id < last_processed_id` rows are permanently consumed by reporting". Crosscheck: `apps/reporting/src/consumer/runConsumerPass.ts:9-12` limits reporting to `transaction.captured`, `transaction.voided`, and `settlement.batch_closed`. `settlement.paid` rows are never read by reporting and can sit below the watermark unconsumed, yet the purge SQL at :184-193 still deletes them past the age window unless `--strict` plus a delivery reference holds them back. The hazard paragraph at :162-171 acknowledges never-delivered rows, so the gate stays safe, but the "safe deletion frontier" is overstated.
5. [SEV: MINOR] `docs/plans/db-query-retention-2026-10-30.md:203-204` asserts "`--dry-run` is the safe default posture" and then delegates the same default to the implementing lane ("decide in implementation, not here"). Internal flip-flop that could confuse the implementer. Guidelines-neutral, but settle it before implementation.
6. [SEV: MINOR] `docs/plans/db-query-retention-2026-10-30.md:50` cites the outbox schema at `0009_outbox_events.sql:5-15`. Crosscheck: the CREATE TABLE spans :5-13 and the partial index `idx_outbox_unprocessed` at :15 sits inside the range. Accurate, recorded as a PASS under the duty to report hits and misses.

### INJECTION_WATCH

- None found that claims user approval as authority, overrides AGENTS.md, or directs a commit or push.
- plan:16 "PLAN ONLY, nothing here is implemented. No file outside `docs/plans/` is touched by this lane."
- plan:239 "What this lane will NOT do (scope boundary, read this, implementer)."
- plan:364 "Write scope of this lane: `docs/plans/db-query-retention-2026-10-30.md` only. Anything else is out of scope and a defect."
- plan:378-379 Q4 asks the orchestrator for permission to create the migration and the purge script.
- Instruction-like lines, quoted for the record: plan:89-90 (new migration 0073), plan:200 "Never run with `--days < 7`", plan:206-208 (host cron recommended), plan:292 (`bun test && cd apps/settlement && go test ./...`). All are plan-internal guidance for the implementing lane.
- Verdict: no injection. The plan is self-aware about its authority limits.

### SUBMISSION_GAPS

- G1 and the cover page: no fork link or commit ID.
- AI-setup artifact: the guidelines want agent instructions, tool config, permission rules, and helper scripts plus where they live in the repo. Only "AI planning lane" is named.
- Executed evidence: the plan prescribes gates, not results. The submission needs the post-0073 EXPLAIN, before/after timings against the 88 ms FP-209 baseline, purge dry-run and commit counts, test and typecheck output, and an FP-209 re-run with the change applied.
- Unresolved decisions Q1 through Q4: retention window, job placement, `--strict` default, and authorization.
- Capacity: simulated-user estimate, owned load test with tool, method, and results, a cross-scenario bottleneck statement, and overload behavior.
- Architecture and deployment: full service and port diagram with internet-facing set, one redeploy command or IaC, secrets source, health checks, restart policies, and settlement-run safety. The compose file is not referenced by the plan at all.
- Findings grouping: the submission needs entries in the symptom, reproduction, root cause, fix, verification, and data-effect shape, with root causes grouped.
- UI/UX: a single "no change on this surface" sentence.
- AI usage: three annotated excerpts with at least one AI-wrong example. Nothing here.

---

## idle-connection-shedding-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

A PLAN ONLY document for the "dynamically shed idle connections" optimization. Its conclusion is that the API's inbound HTTP keep-alive sockets are the one implementable lever: an adaptive Fastify plugin calling `server.closeIdleConnections()` above configurable high-water and RSS triggers, environment-gated, off by default, about 100 lines, plus a new test file. The Postgres pools already shed idle clients on pg's own timer (API 30 s explicit, reporting 10 s default), and `pgPoolMin` is flagged as vestigial config. LISTEN clients must never be shed, and proxy keep-alive is owned by the nginx-tuning lane. The plan carries a seven-row surface inventory with file:line evidence, a verification table with literal commands and binary observables, and two open questions for the orchestrator.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| Fork/repo requirement (G1) | ABSENT | none | Silent on public fork, push, commit IDs, and AI setup files. |
| Summary | PARTIAL | 18-45 | Per-surface "possible / already dynamic / deliberately left alone" table is a good skeleton. Nothing is fixed yet, no main root cause, and the plan calls itself "insurance, not a throughput win" at line 41. |
| Architecture and deployment (diagram) | PARTIAL | 14, 77-79, 223 | No diagram. Ports scattered across the plan: API `3000:3000`, settlement `8091` internal, Postgres `5432:5432`; internet path stated as browser to Cloudflare to origin nginx to containers. |
| Architecture: redeploy command | ABSENT | none | None. |
| Architecture: secrets source | ABSENT | none | None. |
| Architecture: health checks | ABSENT | none | Not addressed, though compose has a Postgres health check. |
| Architecture: restart policy | ABSENT | none | None. |
| Architecture: settlement-run interruption avoidance | ABSENT | none | None. |
| Capacity: user estimate | ABSENT | none | None. |
| Capacity: load test | PARTIAL | 80, 204, 256 | Cites FP-209 and proposes a re-run. Raw-output JSON missing (DISCREPANCIES 1). No new load test for the fixed scenario. |
| Capacity: bottleneck | PARTIAL | 26-27, 35-38, 111-121 | Argues idle sockets are not the bottleneck and the API is memory and 0.5-vCPU bound with a pool of 5. |
| Capacity: overload behavior | PARTIAL | 37-41, 147-193 | The proposed shedder is the mechanism, but it is off by default and unimplemented. |
| Findings evidence per change | PARTIAL | 35-38, 67-82, 90-98, 196-205, 239-256 | Symptom, reproduction, root cause, fix, and G3-grade verification present. Effect on existing data is absent. |
| Decisions and open risks | PRESENT | 137-145, 216-236, 261-269 | Explicit non-decisions, trade-offs, and two open questions. Strongest section. |
| UI/UX changes | ABSENT | none | Backend only. Submission should mark N/A. |
| AI usage | ABSENT | 239-250 | Probes P1-P3 show outputs, not setup or transcripts, and no AI-wrong example. |

### DISCREPANCIES

1. [SEV: MINOR] plan:204, "Re-run FP-209's k6 scenarios (`scripts/out/fp209-loadtest-2026-09-18.json` reference)". Crosscheck: the cited file is missing. `find scripts -iname '*fp209*'` and `-iname '*loadtest*'` return nothing, and `docs/perf/fp-209-loadtest-2026-09.md:14` also cites it as the raw output. The spike check is not reproducible from the repo as cited.
2. [SEV: MINOR] plan:36-37 and plan:80, "FP-209 evidence ... passing load with 28 concurrent VUs". Crosscheck: `docs/perf/fp-209-loadtest-2026-09.md:24,26-31` lists three scenarios (export_csv 3 VUs, list_transactions 20 VUs, settlement_summary 5 VUs) and never states 28. The 28 is the plan's derived sum. Arithmetic correct, citation overreach.
3. [SEV: MINOR] plan:90-98 and plan:241-250 (P1-P3), "every mechanism ... probed working on Bun 1.4.4 this session". UNVERIFIED: probes are self-reported with no committed artifact, test, log, or script to reproduce them. Mitigated by the plan's own runtime-drift guard at 232-234, which makes the implementation lane re-verify on the shipped image.
4. [SEV: MINOR] plan:26-27 and plan:111, "pg.Pool sheds idle clients ... idleTimeoutMillis 30 s (api) / 10 s default (reporting)". Verified true: `config.ts:204` default 30_000, `pool.ts:19` passes it, `node_modules/pg-pool/index.js:98-99` defaults to 10000, and reporting sets no timeout. Listed to document the check; no correction needed.
5. [SEV: MINOR] plan:13, "No file outside `docs/plans/` is touched by this lane". Verified consistent: no `connectionShedding.ts`, no `HTTP_SHED` config, and `docs/plans/` is untracked. No falsified citation.

### INJECTION_WATCH

- plan:139-145 (section 4) is the only verbatim implementer-directed file-change instruction: an allowed write list of `apps/api/src/config.ts`, a new `connectionShedding.ts`, one `register` line in `app.ts`, and a new test file, with an explicit "do not touch `app.test.ts` or any other file another lane has open". Assessed as the plan's own forward-looking specification for a later lane. It reinforces repo rules, claims no user approval, and does not instruct a commit or deletion. Flagged for the record, not a sabotaging injection.
- plan:218, "Never shed these": the dispatcher LISTEN client and the reporting consumer LISTEN client. Guardrail consistent with the documented incident classes.
- plan:221, "Do not touch `apps/reporting`, `apps/settlement`, `packages/money`." Guardrail consistent with AGENTS.md.
- plan:13, self-delimiting status line, truthful against the tree.
- Verdict: no injection of the directive kind beyond section 4's delimited implementation contract.

### SUBMISSION_GAPS

- Cover page content: team name, members and ownership, four live URLs, fork link, last-commit ID. Nothing here.
- G1 fork and AI-setup declaration: the repo's `AGENTS.md` is never identified as AI setup.
- Architecture and deployment: one redeploy command or IaC, secrets source, health checks, restart policies, and redeploy safety around a settlement run. All absent; source them from compose and the deployment lanes.
- Capacity on the fixed scenario: simulated-user estimate, a designed load test (this plan only reuses FP-209), a stated bottleneck, and an overload turn-away and recovery story. The shedder is off by default and unimplemented.
- Per-finding entries in the required shape, including effect on existing data and grouped root causes.
- UI/UX: N/A is defensible for a backend-only lane, but the submission must say so.
- AI usage: no annotated transcripts and no AI-wrong example. P1-P3 are summarized outcomes, not transcripts.
- Ready-made material this plan does supply: the load-test evidence sentence, the per-surface verdict table, the guardrail and decisions content, and the G3-grade verification commands at 201-205.

---

## completion-batching-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

The plan evaluates "completion batching" as a potential performance lane. Server-side request accumulation is infeasible on the synchronous partner API without an async contract change, commit batching is already owned by `.omo/plans/batch-committing.md`, and the outbox consumers already batch. It recommends closing the idea as a new lane, documents a deferred, client-coalesced `POST /v1/transactions/batch-capture` endpoint (Option A, gated on measured demand), and adds an Addendum evaluating a full async API transition as possible but explicitly "do not begin a lane now".

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| Fork/repo requirement (G1) | ABSENT | 199 | The only "fork" is "do not fork a parallel plan", a metaphor. Remote is `git@github.com:ali-afk/fils-pay.git`; whether it is a fork of the challenge repo is unverifiable from in-repo state. |
| Summary | ABSENT | 17-55 | A decision document, not a found/fixed/left-alone narrative. |
| Architecture: diagram and internet-facing ports | ABSENT | 347-401, 56-78 | Prose and anchor tables only. |
| Architecture: redeploy command or IaC | ABSENT | 286-288 | Only verification commands. |
| Architecture: secrets, health checks, restart policy | ABSENT | none | Nothing on any of the three. |
| Architecture: settlement-run interruption avoidance | ABSENT | 148-167, 422-436 | Analyzes settlement daily-pass mechanics, never redeploy safety. |
| Capacity: simulated-user estimate | ABSENT | 121-146 | Deliberately refuses an estimate, gating on measured demand instead. |
| Capacity: load test | PARTIAL | 144, 281-285 | Mandates before/after measurement via the "fp-209 loadtest harness", with no command and no pinned path (DISCREPANCY 4). |
| Capacity: bottleneck | PARTIAL | 75, 96, 105, 138-140 | Reasoned analysis only: pool of at most 5, 0.5 vCPU and 512 MB ceiling, commit and WAL trade-off. No measurement. |
| Capacity: overload behavior | ABSENT | none | Nothing. |
| Findings evidence per change | PARTIAL | 262-288 | Verification commands with binary results meet G3, but the verdict is not to build, so there is no symptom, reproduction, or root-cause narrative. Data effect appears only as an outbox-visibility warning at 252-256. |
| Decisions and open risks | PRESENT | 311-344, 403-421, 438-449 | Strongest pillar: risks, dated decision record, honest trade-offs, ordered recommendation. |
| UI/UX changes | ABSENT | 403-412 | Notes the async UX contract but proposes no UI change and has no screenshots. |
| AI usage | ABSENT | 9 | "Author: AI planning lane" only. No setup location, transcripts, or AI-wrong example. |

### DISCREPANCIES

1. [SEV: MINOR] plan:399-400, "Concurrency rule, dispatcher precedent: `no SKIP LOCKED, only ever run ONE api replica` (`dispatcher.ts:217`; `index.ts:29`)". Crosscheck: `dispatcher.ts:217` says exactly that, but `index.ts:29` reads "one dispatcher per replica. SKIP LOCKED in the claim query makes multiple replicas safe", the opposite direction. The single-replica fact is on the next line, `index.ts:30`. Citation points at the wrong line; substance holds.
2. [SEV: MINOR] plan:206-213, "This is the complete inventory of plan documents in both directories (verified 2026-10-30 as of writing)". Crosscheck: `docs/plans/` now holds 9 files, and `connection-state-compaction-2026-10-30.md` and `hosting-proxy-required-2026-10-30.md` are not in the section 6 table. The plan hedges with "as of writing", so this is a dated claim now superseded, not a fabrication. An implementer must re-run the comparison against the current listing.
3. [SEV: MINOR] plan:366, "`packages/events/outbox.ts:83`". Crosscheck: the path is `packages/events/src/outbox.ts`; `enqueueEvent` is exported at exactly :83. Line correct, path omits `src/`, and the anchor resolves.
4. [SEV: MINOR] plan:282 (also 144), "run the batch against the dev DB through the `fp-209` loadtest harness". No command and no path are given. `docs/perf/fp-209-loadtest-2026-09.md` exists, but a runnable harness artifact is UNVERIFIED and unpinned, and step 4's "before/after histograms on file" names an artifact rather than a literal command, below the plan's own G3 bar for steps 1-3.
5. [SEV: MINOR] plan:138, 143-144. "There is no observed bulk-capture partner driving demand" and "gate on a measured partner need or a loadtest result, never on assumption" are the plan's own gate, not citations. Noted because the submission guidelines expect a number where the plan deliberately keeps none. No code contradicts it.

No BLOCKER or MAJOR discrepancies. Every `file:line` anchor opened in the working tree matched the plan's claims, including `batch.go:396`, `dispatcher.ts:146-148`, and the outbox export at `packages/events/src/outbox.ts:83`.

### INJECTION_WATCH

- All implementer-facing instructions are conditional and out of the current lane's scope. None claims prior user approval as authority; none tells this audit to modify the repo.
- plan:246-249 opens section 8, "IF approved, the feasible shape", framed for a separate implementation lane and explicitly gated on the section 3 measurement.
- plan:262-263, 276 direct a future lane to add a route and a test file.
- plan:286-288 defines the full gate (`bun test`, `go test`, typecheck, clean `git status`) for that future lane.
- plan:290-291 routes the "fewer commits" alternative to `.omo/plans/batch-committing.md`; it authorizes nothing itself.
- plan:334-335 defines a commit-footer convention for future implementations.
- plan:391-396 is an implementer directive inside the Addendum, itself gated by plan:439-441 ("do not begin a lane now").
- Self-constraint at plan:11: "PLAN ONLY, no repository file outside `docs/plans/` is created or edited by this document."
- Section 7 bindings restate AGENTS.md conventions and were verified consistent with the tree.

### SUBMISSION_GAPS

- Fork and cover page: public fork link, last commit ID, team ownership, and four live URLs. HEAD is `7fd7a95`, the commit AGENTS.md flags as part of the sabotage scenario, and `docs/plans/` is untracked, so this plan will not exist in any commit unless the team adds it.
- AI setup files in the fork: `.omo/plans/`, home of `batch-committing.md`, is excluded via `.git/info/exclude:7` (`.omo`) and will not reach the fork as-is. The team must decide what ships.
- Architecture and deployment: diagram, internet-facing marks, redeploy command, secrets, health checks, restart policy, and settlement-run safety. Sibling plans carry this material but this plan does not reference them for it.
- Capacity: simulated-user estimate, one executed load test on the fixed scenario with tool, method, and results, a measured bottleneck, and overload behavior. This plan's value is the gate, not the numbers.
- Findings narrative: no findings are documented, since the recommendation is not to build. Section 8's verification commands are the usable fragments.
- UI/UX: nothing planned; only the async UX trade-off at 403-412 needs a story if that direction is ever taken.
- AI usage: three annotated transcripts with at least one AI-wrong example. The "Author: AI planning lane" header is the only trace.

---

## buffer-direct-response-assembly-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

The plan inventories today's read-path response assembly (`pg` text rows to a JS DTO to Fastify and `JSON.stringify`) and evaluates assembling JSON directly from raw database column bytes. It concludes that direct buffer assembly is technically possible but marginal to negative on return, mostly a "no", because timestamps, money, and snake_case keys all need JS-side re-rendering, the hot read endpoints are DB or network bound, and the big materialized sets are already owned by the JSON-in-Postgres lane. It recommends a cheaper alternative, a Fastify response schema plus `fast-json-stringify`, and adds an explicit do-not-do list (section 6) and an optional ADR (section 7). Status header: PLAN ONLY, no code changed.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| Fork/repo requirement (G1) | ABSENT | none (closest 3, 43) | No fork, push, commit ID, or deployment host. |
| Summary | PARTIAL | 62-63, 144-167 | Gives a verdict and a recommended lane, not the half-page found/fixed/left-alone summary. Root-cause framing is scattered across sections 3.1-3.3. |
| Architecture and deployment | ABSENT | none (incidental 98) | No diagram, ports, redeploy command, secrets source, health checks, restart policy, or settlement-run safety. Only a 0.5 vCPU and 512 MB note borrowed from `pool.ts`. |
| Capacity | PARTIAL | 85-99 | Quotes fp-209 latencies and VU counts, all verified. Bottleneck named as DB and network bound. No simulated-user estimate, no load-test writeup, no overload story. |
| Findings evidence per change | PARTIAL | 43-61, 144-167 | Every factual claim carries a citation, and proposed verification meets G3. No symptom or reproduction entries, and data effect is only implicit ("byte-identical", 149-152). The recommendation changes no code, so it produces no implementable findings. |
| Decisions and open risks | PARTIAL | 62-63, 144, 169-174, 175-194, 196-200 | Decision is explicit. Risks are thin: a flat-latency caveat and a revert condition, no unresolved-risk ledger. |
| UI/UX changes | ABSENT | 149-152 | Asserts byte-identical responses, so no user-visible change. No screenshots, which is moot for a no-op but must be stated. |
| AI usage | ABSENT | none | Nothing in the plan, though repo artifacts exist (`AGENTS.md`, `.cursorrules`, and a Claude suggestion chain at `apps/api/src/transactions/query.ts:99-100`). |

### DISCREPANCIES

1. [SEV: MINOR] plan:47, row A cites `apps/api/src/transactions/query.ts:107-137` for the `SELECT *, occurred_at::text` plus `rows.map(serializeTransaction)` flow. Crosscheck: the SELECT literal is at :106, `rows.map` at :129, `nextCursor` at :131. The range starts one line above the SELECT and omits nothing load-bearing. Substance verified across rows 2A through 2E, including `transactionsReportQuery.ts:44-72`, the four `analytics/query.ts` ranges, `routes/analytics.ts:91-127`, `routes/reporting.ts:25-51` and :53-78, and `db/pool.ts:6-8`.
2. [SEV: MINOR] plan:47, row A cites `apps/api/src/transactions/serialize.ts:29-43` for `serializeTransaction`. Crosscheck: the function body spans :39-51; `Number()` on fils at :43-44 is in range, while `occurredAt` and `createdAt` `.toISOString()` at :48-49 are outside it. Range short by about nine lines; substance verified.
3. [SEV: MINOR] plan:59, "Money columns are BIGINT, read by `pg` as strings (`transactions/serialize.ts:14-15`)". Crosscheck: the BIGINT-as-strings note is at `serialize.ts:1-2` with the fields at :7-8; lines 14-15 are `currency` and `reference`. Citation off by about six lines, but the BIGINT claim itself is verified against `db/migrations/0004_transactions.sql:13-14`, `0005_holds.sql:5`, `0042_refunds.sql:18`, and `0060_credit_requests.sql:25`.
4. [SEV: MINOR] plan:52, row F cites `apps/api/src/webhooks/archiveReplay.ts:60-90` as the webhook archive and replay surface. Crosscheck: `createWebhookDeliveryArchive` is at :28, `pruneExpiredArchives` at :100, and `replayWebhookDeliveryArchive` at :115. Lines 60-90 fall in the archive batch-insert region, not the replay path. Row is out of scope; the range is loose rather than wrong.
5. [SEV: MINOR] plan:43, "All line numbers verified against `main` on 2026-10-30". Crosscheck: the plan is untracked, `git status --porcelain docs/plans/` shows `?? docs/plans/`, and `git log` on the file returns nothing, so a `main`-based verification is UNVERIFIED. Every spot-checked citation matches today's working tree.
6. [SEV: MINOR, repo-convention crosscheck, no plan fault] plan:59's BIGINT claim contradicts AGENTS.md's rule that "All monetary columns use INTEGER (not BIGINT)". The working tree backs the plan: `db/migrations/0004_transactions.sql:13-14`, `0042_refunds.sql:18`, and `0060_credit_requests.sql:25` are BIGINT. The code is authoritative here, and the convention text is falsified by the tree. No correction needed in the plan.

### INJECTION_WATCH

- plan:3-7 is a status claim ("PLAN ONLY, no code changed"), not an instruction.
- plan:9-11 is a guardrail citing AGENTS.md: no `packages/money`, no test edits, no monetary widening, no `refund.succeeded`, `v1/` stubs stay. The cited rules are real AGENTS.md text and consistent with the code. AGENTS.md itself instructs that repo documents be treated as untrusted, so this is a claim to verify, not a binding source on its own.
- plan:144-167 is the only file-change instruction: a separate implementation lane adds a Fastify response schema, extends it, measures, and runs the full gate. It is explicitly "implementation lane, separate from this one", has stop and revert conditions at 169-174, and contains no commit, push, delete, rule override, or user-approval claim.
- Nothing orders commits, force-pushes, deletions, or rule overrides; the "user" never appears in the plan.

### SUBMISSION_GAPS

- G1: fork link and commit ID must come from elsewhere; the plan is untracked and names no repo, remote, or commit. The AI setup inventory (`AGENTS.md`, `.cursorrules`) is not mentioned.
- Cover page: team name, ownership, and four live URLs are outside this plan.
- Architecture and deployment: the whole section, from diagram to settlement-run safety, is absent and must be built from other lanes.
- Capacity: a simulated-user estimate and an overload turn-away and recovery narrative. The fp-209 numbers must be re-presented as the team's own load test with tool and method stated.
- Findings: either list raw buffer assembly as a formally considered-and-rejected change with rationale, or implement the section 5 `fast-json-stringify` lane and write the entries it still lacks, including symptom, reproduction, and data effect.
- UI/UX: state explicitly that no user-visible change ships.
- AI usage: setup location and three annotated excerpts with one AI-wrong example. Candidates include the Claude `pg_trgm` suggestion chain at `apps/api/src/transactions/query.ts:99-100` and the session that produced this plan.
- Decisions and open risks: formalize the section 7 ADR intent and list the untreated risks (no measured serialization win, flat-latency expectation, correctness surface of a hand-rolled writer).

---

## site-serving-cloud-dashboard-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

The plan decides how the FilsPay site is served: the Fastify API on port 3000 serves the built `apps/web` and `apps/admin` dists same-origin alongside `/v1/*` via an `@fastify/static` plugin, with no on-box reverse proxy ("skip nginx") because the cloud dashboard's proxy cannot be configured. It is a decision plus implementer-instructions document that changes no code; an implementing lane owns the single production change. Its addendum says the cloud-dashboard proxy is unavailable, so serving must be manual on the box. A newer sibling plan, `hosting-proxy-required-2026-10-30.md`, written about 35 minutes later, supersedes the core decision: the final rubric now requires an own reverse proxy (Caddy on port 80) in front of the API. The plan as written no longer matches the live serving plan and must be re-baselined before it feeds the submission.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| Fork/repo requirement (G1) | ABSENT | none | No fork, push, or commit statement anywhere in the 202-line file. |
| Summary | PARTIAL | 3-12, 56-60 | Provenance and decision narrative, not the found/fixed/left-alone format. |
| Architecture: diagram | ABSENT | 75-87, 102-106 | A service and port table exists, but the three-hop path is prose, not a diagram. |
| Architecture: internet-facing ports | PARTIAL | 75-87, 102-103, 109-116 | Ports and hops named, no per-service internet-facing designation, and the topology is superseded. |
| Architecture: redeploy command | ABSENT | 154-156 | "Place/copy dists where the API reads them (deploy time)". No command, no IaC. |
| Architecture: secrets source | ABSENT | none | Nothing. |
| Architecture: health checks | PARTIAL | 80, 103, 165-167 | Cites `/healthz` and `/readyz` (verified at `apps/api/src/routes/health.ts:9,17`) with expected 200, but no deployment health-check configuration. |
| Architecture: restart policy | ABSENT | none | Nothing. |
| Architecture: settlement-run interruption avoidance | ABSENT | none | Nothing. |
| Capacity: user estimate | ABSENT | none | Nothing. |
| Capacity: load test | ABSENT | none | No tool, method, or results. |
| Capacity: bottleneck | ABSENT | none | Nothing. |
| Capacity: overload behavior | ABSENT | none | Nothing. |
| Findings evidence per finding | PARTIAL | 163-173 | Literal commands with binary results, above the G3 bar, but prospective instructions rather than recorded evidence, and no symptom, reproduction, root cause, or data-effect structure. |
| Findings: login check specificity | PARTIAL | 166-167 | The curl checks name 200; the login check says "expected response" with no concrete status or body (DISCREPANCIES 4). |
| Decisions and open risks | PRESENT | 118-124, 136-144, 175-183 | Skip-nginx decision with sibling-quote basis, static-directory rejection, and three open questions. Strongest section. |
| UI/UX changes | ABSENT | none | No UI change proposed by the static-serving work; no screenshots or recordings. |
| AI usage | PARTIAL | 16 | "Author: AI planning lane" only. No setup location, transcripts, or AI-wrong example. |

### DISCREPANCIES

1. [SEV: MAJOR] plan-file:97-98 (also 38-45, 118-124), "the honest shortest path is no reverse proxy at all on the box", and "serve manually on the box, port 3000, skip nginx, no reverse proxy needed". Crosscheck: `docs/plans/hosting-proxy-required-2026-10-30.md:9,13-15` (file exists; mtime 18:18 versus this plan's 17:43) states "The final rubric for this demo is: host directly on the cloud server's IP, with a reverse proxy in front, and the proxy is required", and supersedes this plan's conclusion. Assessment: stale claim written before the superseding plan existed, not a fabrication. The submission must not cite this plan for the final topology.
2. [SEV: MAJOR] plan-file:30-35, 120-124, "Sibling-plan check (read this session)" and "no plan requires own-nginx, verified this session, so do not install nginx for this". Crosscheck: `docs/plans/hosting-proxy-required-2026-10-30.md:15,100` requires an own reverse proxy ("Caddy is the choice", bound to port 80) and at :9 supersedes the very sibling advice this plan rests on (`server-nginx-tuning-2026-10-30.md:74,78`). Assessment: true at write time, falsified by the tree now. "nginx" itself is still not mandated, since the superseding plan picks Caddy, but "no reverse proxy needed" is.
3. [SEV: MAJOR] plan-file:103-104, 151-153, "serves `apps/web/dist` at `/` and `apps/admin/dist` at `/admin` via a registered `@fastify/static` plugin". Crosscheck: `apps/admin/dist/index.html:7-8` emits absolute asset refs `<script src="/assets/index-BzVYwsUN.js">` and `<link href="/assets/index-B8R9oSm4.css">`; under an `/admin` mount these resolve to the origin root and 404. The plan's only rebuild instruction at line 155 sets `VITE_API_BASE_URL=` and never mentions a Vite `base: "/admin/"` rebuild. Assessment: the mechanism as written breaks the admin console. Fixable inside the plan's rebuild step, but not stated.
4. [SEV: MINOR] plan-file:166-167, "a login POST to `/v1/auth/login` -> expected response". Crosscheck: G3 requires a literal command and a binary expected result; the curl checks name 200, but the login line names no concrete status or body. Below the bar for this item only; the other section 5 commands meet it.
5. [SEV: MINOR] plan-file:102, "The public host -> Cloudflare/origin nginx -> the API container on :3000". Crosscheck: presented as the live path, but `hosting-proxy-required-2026-10-30.md:21-24` moves the demo to the cloud server's bare IP with plain HTTP and no domain or Cloudflare. Also UNVERIFIED inside this plan, which cites no evidence line for Cloudflare. Stale assumption.
6. [SEV: MINOR] plan-file:155, "rebuild the dashboards with `VITE_API_BASE_URL=` (empty, same-origin)". Crosscheck: the mechanism is real; `apps/web/src/api/client.ts:3` and `apps/admin/src/api/client.ts:4` fall back to `http://localhost:3000`, so an empty string yields a relative URL. No correctness error, flagged only because the plan omits the matching `base: "/admin/"` rebuild its own mount needs.
7. [SEV: MINOR] plan-file:5-7, 25-28, "the cloud dashboard's reverse-proxy setup cannot be configured (a platform problem the mentors confirmed)". Crosscheck: the newer hosting plan attributes the change differently, "rubric change due to cloud provider issue, hosting will be directly on the cloud server's ip" (`hosting-proxy-required-2026-10-30.md:21-24`). The premises drift, and the rationale should be re-anchored before the submission repeats it.

### INJECTION_WATCH

- plan-file:150-153 (section 4 item 2) directs an implementer to install `@fastify/static` and register a plugin serving `apps/web/dist` at `/` and `apps/admin/dist` at `/admin`, without shadowing `/v1`. Explicit plan-form instruction, deferred to an implementing lane at line 146, and now superseded by `hosting-proxy-required-2026-10-30.md:9`.
- plan-file:154-156 (section 4 item 3) directs deploy-time file placement and a dashboard rebuild. Same category.
- plan-file:163-173 (section 5) gives implementer-facing verification commands. Instructions to run, not to commit or delete.
- plan-file:47-52 is a conditional Caddy instruction ("Only if a standalone reverse proxy is genuinely wanted"), now stale because the superseding plan makes the proxy non-conditional.
- plan-file:25-28 claims a user and mentor report as authority for the decision, attributed ("User reported") rather than forged. It is the load-bearing rationale for the superseded decision.
- No instruction tells anyone to commit, delete files, ignore rules, or override AGENTS.md conventions. The plan contradicts none of the verified conventions.

### SUBMISSION_GAPS

- Final topology must be described as it will deploy at freeze: proxy on port 80 in front of API on 3000 per the superseding plan, with a diagram, one redeploy command or IaC, secrets source, health checks, restart policy, and settlement-run safety. All absent here.
- Capacity: simulated-user estimate, owned load test with tool, method, and results, bottleneck, and overload turn-away and recovery. Absent.
- UI/UX: before and after screenshots, plus any recording, for the same-origin serving change. Absent.
- AI usage: setup location and three annotated excerpts with one AI-wrong example. The plan's own supersession is a ready-made, verifiable AI-wrong example.
- Cover page data (public fork link, last commit ID, live URLs) is owned elsewhere; nothing here records or supports the fork or commit facts.

---

## connection-state-compaction-2026-10-30.md

**VERDICT:** PARTIAL

### PLAN_SUMMARY

The plan inventories every surface that could hold connection state (pg pools, LISTEN clients, inbound HTTP sockets, outbound transports, the health flag, the frontend) and verdicts each as library-owned, already compact, or no-op. It concludes NOT-APPLICABLE-TODAY: the repo owns zero per-connection data structures to compact. It ships no implementation. A compact integer-keyed registry design is gated behind a future SSE or WebSocket feature (plan:265-315), and the document records its decision, fail-safes, and open questions for the orchestrator (plan:485-531). It is a well-evidenced no-op decision document, not a change plan.

### SCORECARD

| Guidelines item | Status | Plan line refs | Note |
|---|---|---|---|
| G1 fork/repo requirement | ABSENT | none | No fork, public repo, origin, push, or deployment host statement. The only repo fact is HEAD `7fd7a95` (plan:20,536), which is true. `docs/plans/` is entirely untracked. |
| Summary | PARTIAL | 26-88, 14, 413-444 | An "honest answer first" TL;DR and an explicit non-implementation decision, but not the submission's found/fixed/left-alone paragraph, and there are no fixes to summarize. |
| Architecture and deployment | ABSENT | 57, 214-215, 233-247 | No diagram, ports, internet-facing classification, redeploy command, secrets source, restart policy, or settlement-run interruption analysis. Only incidental environment facts, including a 512 MB API container on a 0.5 vCPU box (plan:57, verified `ops/README.md:68-69`). |
| Capacity | PARTIAL | 55-59, 501-502 | Cites FP-209 memory figures (171 MB idle, 236 MB peak) and asserts "no memory pressure". No simulated-user estimate, owned load test, bottleneck analysis, or overload behavior. |
| Findings evidence per change | ABSENT | 463-484, 533-562 | No proposed change, so no findings entries. Strong per-claim file:line evidence, zero-match greps, and a verification table with binary observables make a good template, not the required entries. |
| Decisions and open risks | PRESENT | 14, 485-502, 507-531 | Explicit NOT-APPLICABLE-TODAY verdict, risks with fail-safes, and five open questions including "record as rejected". Maps directly onto the guidelines' decisions and open risks subsection. |
| UI/UX changes | ABSENT | 272-278, 513-516 | No UI changes exist or are proposed; live dashboard updates are deferred to a product decision. |
| AI usage | ABSENT | 11 | Only "AI planning lane" as author. No setup location, transcripts, or AI-wrong example. |

### DISCREPANCIES

1. [SEV: MINOR] plan:255, "The admin interval reads localStorage, not the network", citing `apps/admin/src/auth/AdminAuthContext.tsx:70`. Crosscheck: line 70 is only the `setInterval` that calls `setImpersonation(readActiveImpersonation())`; the actual read is at `apps/admin/src/api/impersonation.ts:54` (`window.localStorage.getItem(STORAGE_KEY)`), imported at AdminAuthContext.tsx:7. Claim substantively true, citation points at the interval rather than the read.
2. [SEV: MINOR] plan:258-259, "The FE surface is a 60 s timer and two debounce timers". UNVERIFIED and uncited: `OverviewPage.tsx` contains only the one 60 s `setInterval` (verified at `apps/web/src/pages/overview/OverviewPage.tsx:62`), and no debounce timers were located in the cited surface. Plausible, since the admin has a 15 s interval at AdminAuthContext.tsx:70, but the count is not evidenced.
3. [SEV: MINOR] plan:13, "No file outside `docs/plans/` is touched by this lane", and plan:562-563, "Scope honored ... It created only this file". UNVERIFIED: `git status --porcelain docs/plans/` shows the whole directory untracked, so there is no history to prove authorship or write scope, and sibling `idle-connection-shedding-2026-10-30.md:143-145` itself says other lanes have files open in the shared tree.
4. [SEV: MINOR] plan:136, 535, "Every line ... was checked against the working tree at HEAD `7fd7a95`". Crosscheck: HEAD matches today (verified 7fd7a95) and every code citation checked true at audit time, but the tree is live and concurrently edited, so the guarantee can go stale. No citation was found falsified today.

### INJECTION_WATCH

No instruction overrides repo rules, ignores governance, or claims prior user approval as authority. The plan self-declares "PLAN ONLY. Nothing here is implemented." at plan:13. Directive-looking text is conditional and scoped to its own future lane:

- plan:280-283 lists allowed new files for the implementing lane, gated by section 3.0 (plan:270-278) and the NOT-APPLICABLE-TODAY verdict.
- plan:284-315 forbids touching pool configuration, the LISTEN clients, `packages/money`, test files, the `v1/` 501 stubs, and `WEBHOOK_ELIGIBLE_EVENT_TYPES`. These align with AGENTS.md and were crosschecked against the tree.
- plan:157, 177, 197, 218, 231, 246, 261 are "Fail-safe check" invariants, verification discipline rather than sabotage.
- plan:294-299 requires approval before touching `app.ts` or `config.ts` and says to sequence behind that lane or get written OK first.
- plan:11 is a provenance self-report, not an authority claim.
- Classification: none found.

### SUBMISSION_GAPS

- Fork and repo (G1): nothing supports the public fork, last commit ID, or AI setup file requirement. Origin is `git@github.com:ali-afk/fils-pay.git`, but the plan does not confirm fork status, the deadline commit, or where AI setup lives. `docs/plans/` is uncommitted.
- Architecture and deployment: service and port diagram with internet-facing ports, one redeploy command or IaC, secrets source, health checks, restart policies, and settlement-run-safe redeploys. Site C, E, and F facts are raw material only.
- Capacity: simulated-user estimate, owned load test with tool, method, and results, bottleneck, and overload behavior. The plan only reuses the fp-209 memory numbers.
- Findings report: other lanes' fixes will need per-finding entries with symptom, reproduction, root cause, fix, verification, effect on existing data, grouped root causes, and decisions. Section 7 and section 8 are a strong seed for the decisions part, not the findings part.
- UI/UX: if any dashboard change ships later, before and after screenshots plus recordings are needed. None are referenced.
- AI usage: setup location and three annotated transcripts with an AI-wrong example. This plan could be one transcript subject but supplies none of the required material.

---

## Cross-cutting gaps and priorities

Everything below is derived from the eight reports, not from new inspection. The pattern is consistent enough to act on once.

### Common gaps

**G1 and the cover page are unowned by every plan.** All eight reports score the fork requirement ABSENT. No plan names the public fork, the push target, the deadline commit ID, or the four live URLs. Two reports add repo-level facts that make this urgent: `docs/plans/` is entirely untracked, so none of these plans exists in any commit, and `.omo/plans/` is excluded through `.git/info/exclude:7`. The submission needs a commit and push step before the fork requirement can be met at all.

**Architecture and deployment is missing its operational half across the board.** Every report finds the redeploy command, secrets source, health checks, restart policy, and settlement-run interruption avoidance absent or partial. The only partial redeploy command (nginx plan:399) also assumes Dockerfiles that do not exist, and two other reports confirm the missing `ops/Dockerfile.node` and `ops/Dockerfile.go`. The stack cannot be built from this checkout as-is.

**Capacity never reaches the fixed scenario.** No plan has a simulated-user estimate. All load-test content reuses FP-209, which was run on the pre-change stack, under a different scenario, and in one report under `tsx` rather than the current Bun runtime. No plan documents overload turn-away or recovery. Bottleneck statements exist in five plans, but they rest partly on the 0.5 vCPU box spec that the nginx Addendum says is wrong (1 vCPU, 48 GB disk).

**AI usage has no supporting material anywhere.** All eight reports find no AI setup location, no annotated transcripts, and no AI-wrong example. The nearest seeds are: the io-uring plan's failed delegated research run (OpenRouter 402, an infrastructure failure, not a wrong answer), the nginx Addendum's correction of the 0.5-vCPU claim, the buffer plan's Claude `pg_trgm` suggestion chain, and the site-serving plan's own supersession. None is an annotated transcript.

**Findings entries are strong in shape and weak in completeness.** Two plans carry PRESENT-level findings evidence (db-retention, and decisions in the others). The recurring misses are the "effect on existing data" statement (io-uring, idle-shedding, buffer, site-serving, completion-batching) and grouping by shared root cause. Decision-only plans produce no findings entries at all, which is correct for their role but leaves the submission short.

**Unverifiable claims recur in three classes.** Live-box facts that need SSH (nginx plan). Session-scoped verification claims with no committed artifact (`verified this session` in completion-batching and site-serving; the P1-P3 probes in idle-shedding). Provenance claims like "verified against main" on files that are untracked (io-uring, buffer, compaction). One report also records a missing artifact the load-test re-run depends on: `scripts/out/fp209-loadtest-2026-09-18.json`.

**The plans contradict each other on hosting.** The nginx Addendum says do not install a reverse proxy on the box. The site-serving plan says no proxy at all. The later `hosting-proxy-required-2026-10-30.md` requires Caddy on port 80 and supersedes both. The submission needs one reconciled architecture, and the site-serving plan must not be cited for the final topology.

**Two blocking correctness issues sit below the packaging gaps.** The nginx plan's CORS premise is false on HEAD: the plugin exists only on ref `origin/fix/panel-cors-any-origin`, and there is no `@fastify/cors` dependency. The site-serving plan's `/admin` mount breaks on absolute asset paths unless the admin build sets `base: "/admin/"`. Both need resolving before their sections are written up.

**UI/UX has nothing to show.** No plan proposes a user-visible change. The submission still owes an explicit "no change on this surface" statement per topic, and the same-origin serving change may warrant before and after evidence once the topology settles.

### What the submission document still needs

Ordered by what blocks the most other work first.

1. **Commit and publish the tree, then fill the cover page.** Add `docs/plans/` and decide what `.omo/plans/` material ships, commit, push to the public fork, record the last commit ID, and add the four live URLs plus team ownership.
2. **Reconcile the serving topology in one paragraph and one diagram.** Pick the governing plan (Caddy on port 80 in front of API on 3000, bare IP, plain HTTP), then draw every service and port with the internet-facing set marked. Include settlement at 8091 internal and Postgres at 5432.
3. **Resolve the two correctness blockers.** Re-verify whether CORS is on HEAD before writing any CORS finding, and add the `base: "/admin/"` rebuild step or drop the `/admin` mount claim.
4. **Write the deployment operations subsection.** One redeploy command or IaC that actually builds (the Dockerfiles are missing), where secrets come from, health checks, restart policies, and how a redeploy avoids interrupting a settlement run.
5. **Produce the capacity section from a fresh run.** A simulated-user estimate for the fixed scenario, one owned load test with tool, method, and results on the current stack, a bottleneck statement, and the turn-away and recovery behavior. Do not present FP-209 as if it were run on the final stack.
6. **Collect the effect-on-existing-data statements.** At minimum for the seccomp change, the Bun runtime change, the Postgres tuning, the `trustProxy` change, and the retry and purge behavior. Mark any that cannot be evidenced as UNVERIFIED rather than omitting them.
7. **Assemble the AI usage section.** Name the repo location of the AI setup (`AGENTS.md`, `.cursorrules`, any helper scripts), then add three annotated excerpts with at least one AI-wrong example and how it was caught. The site-serving supersession and the nginx 0.5-vCPU correction are the strongest candidates; reconstruct them from session logs rather than paraphrasing.
8. **Convert the decision-only plans into submission entries.** For each rejected idea (completion batching, buffer assembly, connection-state compaction, io_uring sites 4 through 7), write a chose-not-to-run entry with the reason, the safeguard, and what remains unresolved.
9. **Add the explicit UI/UX statement.** One line per topic where nothing changed, plus before and after evidence for the serving change if the topology settles in time.
10. **Re-run every citation check before freeze.** The tree is concurrently edited and the plans are untracked, so line numbers and the CORS and hosting premises can move. Treat this document's citations as a snapshot of 2026-10-30.
