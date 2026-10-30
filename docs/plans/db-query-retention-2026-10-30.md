# Design: query-path index + outbox retention — where and how in FilsPay

> Placement note: this plan lives at `docs/plans/` per the planning-lane contract
> (siblings: `io-uring-optimization-2026-10-30.md`, `server-nginx-tuning-2026-10-30.md`).
> It is the **how-we-will-do-it** document for two data-layer optimizations the
> sibling lanes do **not** cover: (1) the `transaction_events` composite index
> that `docs/perf/2026-07-settlement-summary-slow.md` already lists as an open
> follow-up, and (2) retention of consumed `outbox_events` rows, which today
> grow without bound. It changes **no code**; implementation is a separate,
> later lane.

| | |
|---|---|
| **Author** | AI planning lane (db-query-retention), coordinated with the io_uring, server/nginx, batch-commit, and JSON-in-Postgres lanes |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — nothing here is implemented. No file outside `docs/plans/` is touched by this lane. |

---

## TL;DR — the honest answer first

The infrastructure levers on this stack are already claimed by sibling lanes:
io_uring/seccomp/PG18/Bun (io_uring lane), nginx + host tuning (nginx lane),
settlement batching (batch-commit lane), and webhook archive/replay set-based
SQL (JSON-in-Postgres lane). The two openings those lanes leave are **inside the
database**: one documented-but-open index follow-up on the hottest read path,
and one unbounded table growth that will cap out on the hosted box's 2 GB disk.

| # | Lever | What changes | Rough win |
|---|---|---|---|
| 1 | **`transaction_events (transaction_id, event_type)` index** | One additive migration (`0073`); **zero code change** | Gives the planner an index arm for the settlement summary + reconciliation reads whose July `EXPLAIN` showed a 402,911-row seq scan on `transaction_events`; it is literally an open checkbox in `docs/perf/` |
| 2 | **`outbox_events` retention for consumed rows** | One idempotent maintenance script (+ a scheduled run); **no schema change** | Bounds unbounded JSONB + index growth. Nothing in the tree ever deletes an `outbox_events` row, `processed_at` is written by *nobody*, and the partial index on it therefore spans every row forever — on a 2 GB-disk box that is a real ceiling |

Both are additive and reversible (drop index / stop the script), both are
evidence-gated (run `EXPLAIN` / count queries first; if there is no gain, stop —
a documented "no" is the correct result, same as the sibling plans).

---

## 1. Grounded inventory (verified against the working tree, 2026-10-30)

| Surface | Fact | Where |
|---|---|---|
| Open perf follow-up | "[ ] Index on `transaction_events (transaction_id, event_type)` — try if it gets slow again." | `docs/perf/2026-07-settlement-summary-slow.md:60-61` |
| July EXPLAIN | Settlement summary for Delta Wholesale (30-day window): `Seq Scan on transaction_events te (rows=402911)` + `Hash Join (rows=118204)`; 3.4 s before `shared_buffers` 128 MB, 410 ms warm after | `docs/perf/2026-07-settlement-summary-slow.md` (EXPLAIN block) |
| Summary query | `getSettlementSummary`: `JOIN transaction_events te ON te.transaction_id = t.id WHERE t.merchant_id = $1 AND te.event_type IN ('captured','partially_captured') AND te.occurred_at >= $2 AND te.occurred_at < $3` (sargable window — the good pattern) | `apps/api/src/settlement/query.ts:366-386` |
| Reconciliation query | Same join shape + `settlement_batch_id IS NULL` (pending-unbatched fee estimate) | `apps/api/src/settlement/query.ts:304-311` |
| Existing events index | `idx_transaction_events_transaction ON transaction_events (transaction_id, occurred_at)` — join arm only; no `event_type` discriminator | `db/migrations/0018_transaction_events.sql:23` |
| Event types | `CHECK (event_type IN ('authorized','captured','partially_captured','voided'))` — capture-type joins filter 2 of 4 values | `db/migrations/0018_transaction_events.sql` |
| Outbox schema | `outbox_events(id BIGSERIAL PK, event_type, aggregate_type, aggregate_id, payload JSONB NOT NULL, created_at, processed_at)`; `idx_outbox_unprocessed ON outbox_events (id) WHERE processed_at IS NULL` | `db/migrations/0009_outbox_events.sql:5-15` |
| `processed_at` is vestigial | dispatcher: "This module never reads or writes `outbox_events.processed_at`"; reporting cursor module: "never a reuse of `outbox_events.processed_at`" | `apps/api/src/webhooks/dispatcher.ts:18`; `apps/reporting/src/consumer/cursor.ts:5` |
| Reporting watermark (the safe deletion frontier) | `reporting_outbox_cursor(consumer_name PK, last_processed_id BIGINT, updated_at)` — the reporting consumer commits apply+watermark in ONE transaction (exactly-once), so `id < last_processed_id` rows are permanently consumed by reporting | `db/migrations/0030_reporting_outbox_cursor.sql:10-14`; `apps/reporting/src/consumer/runConsumerPass.ts` |
| No purge exists | No `DELETE FROM outbox_events` anywhere in `apps/`/`scripts/` (only a test-fixture delete in `runConsumerPass.test.ts:159`); file stays read-only | grep 2026-10-30 |
| Outbox readers (complete set) | (a) dispatcher Step A `createMissingDeliveries` reads eligible rows, inserts `webhook_deliveries` with `outbox_event_id`, `ON CONFLICT (outbox_event_id, endpoint_id) … DO NOTHING`; (b) reporting consumer reads by `id > cursor`; (c) Go settlement `payout_notify.go` has an EXISTS guard (`SELECT 1 FROM outbox_events …`) around its `settlement.paid` enqueue — settlement lane's file, read-only here | `apps/api/src/webhooks/dispatcher.ts:88-125` (read at :93, insert at :122); `apps/reporting/src/consumer/runConsumerPass.ts:48`; `apps/settlement/internal/settlement/payout_notify.go:38` |
| Hosted box | 0.5 vCPU / 2 GB RAM / **2 GB disk**; API capped 512 MB | `ops/README.md` (Resource sizing), cited in `docs/plans/server-nginx-tuning-2026-10-30.md` §1 |
| Operational-script precedent | `scripts/expire_holds.ts` (pure SQL builder + tests), `scripts/reconcile_march.ts` (+ integration test) — the pattern a purge script should mirror | `scripts/` |
| Migration numbering | 66 migrations present; max = `0072_refund_merchant_summary.sql`; lexical gaps (0059, 0062, 0063, 0067) are tolerated by the ran-once migrator | `db/migrations/` (ls 2026-10-30); `db/migrate.ts` |

**Current state in one sentence:** the hottest settlement read path joins onto a
table whose only index lacks the `event_type` discriminator, and the
transactional outbox — every capture/void/refund/batch event, JSONB payloads
included — accumulates rows forever with no consumer ever marking or deleting
them.

---

## 2. OPT-1 — `transaction_events (transaction_id, event_type)` composite index

### Facts

- The July incident doc's own follow-up checkbox names this exact index
  (`docs/perf/2026-07-settlement-summary-slow.md:60`). Raising `shared_buffers`
  to 128 MB fixed the symptom then (3.4 s → 410 ms warm); the index is the
  structural step it explicitly deferred.
- Both hot reads drive `transaction_events` through `te.transaction_id = t.id`
  and then filter on `event_type IN ('captured', 'partially_captured')`
  (`getSettlementSummary` query.ts:366-386, `getReconciliationReport`
  query.ts:304-311). The only existing index
  (`idx_transaction_events_transaction (transaction_id, occurred_at)`,
  migration 0018) serves the join but has no `event_type` leading match, so
  the per-transaction lookups re-scan that transaction's full event list.
- With 2 of 4 `event_type` values qualifying (the CHECK column list in
  migration 0018), a `(transaction_id, event_type)` index gives the planner a
  selective index arm for capture-type joins — nested-loop-oriented plans stop
  paying the 402,911-row seq scan the July `EXPLAIN` recorded.

### Plan

1. **New migration `db/migrations/0073_transaction_events_event_type_idx.sql`**
   (additive; 0073 is the next free number after the tree's max, 0072):
   ```sql
   -- Plan-only reference DDL; deciding the column order is the implementer's
   -- EXPLAIN-gated step (see §5 step 1).
   CREATE INDEX idx_transaction_events_transaction_event_type
       ON transaction_events (transaction_id, event_type);
   ```
   Column-order note: the perf doc's recommendation is exactly
   `(transaction_id, event_type)`. The implementer may add `occurred_at` as a
   trailing column (`(transaction_id, event_type, occurred_at)`) **only if**
   `EXPLAIN (ANALYZE, BUFFERS)` on the seeded/staging data shows that the
   window filter is then used as an index condition instead of a filter — the
   leading two columns are the part that changes the plan; decide by evidence,
   not preference.
2. **No application code change.** The queries already use sargable windows
   (`occurred_at >= $2 AND occurred_at < $3` with precomputed UTC instants via
   `bahrainLocalMidnightUtc`, `settlement/query.ts:264-271`) and parameterized
   `event_type` lists — the index slots straight into the existing SQL.
3. **Drop the index if the evidence says so**: if `EXPLAIN` shows the planner
   still chooses the hash join at the same cost, or the perf re-run shows no
   regression improvement, `DROP INDEX` and close the lane item as a
   documented "no benefit on the staged data" — that is the evidence-gated
   design of every lane on this board.

### Benefit / risk

- **Benefit**: index-only / index-scan arm for the two settlement reads that
  the perf docs measured as the slowest merchant-facing path; additive; `DROP`
  is the instant, complete rollback; no writer impact beyond the one CREATE
  INDEX pass (this is a small table at hackathon scale — the index build is
  seconds; on the hosted box, use `CREATE INDEX` plain, not `CONCURRENTLY`,
  because the box is small and `CONCURRENTLY` needs two scans + extra locks;
  decide with the orchestrator if the DB is shared with a live demo).
- **Risk**: index write/update cost on `INSERT`s into `transaction_events`
  (capture/void/refund paths). At this volume (tens of thousands of rows) that
  cost is negligible; the index adds one btree update per written row. The
  July EXPLAIN's 402,911-row scan is a hundred times larger a cost than that.
- **Fail-safe check**: after applying, the two queries' `EXPLAIN` must show
  the new index in the plan (or the implementer explains why the old plan is
  already optimal) and the FP-209 summary scenario must not regress
  (baseline p50 88 ms — `docs/perf/fp-209-loadtest-2026-09.md`).

---

## 3. OPT-2 — `outbox_events` retention for consumed rows

### Facts

- **Nothing ever deletes or marks.** The dispatcher is the only webhook-facing
  reader and it explicitly "never reads or writes `outbox_events.processed_at`"
  (`dispatcher.ts:18`); the reporting consumer keeps its own watermark
  (`reporting_outbox_cursor`, migration 0030) and "never a reuse of
  `outbox_events.processed_at`" (`cursor.ts:5`); the Go settlement app only
  EXISTS-checks rows (`payout_notify.go:38`). No purge exists anywhere
  (grep 2026-10-30).
- **Consequence**: every payment event (`packages/events/src/outbox.ts`
  producers: capture, void, refund) and every settlement-close event appends a
  JSONB row forever. `idx_outbox_unprocessed ON (id) WHERE processed_at IS NULL`
  (migration 0009) has a predicate no row ever leaves, so the partial index
  spans the whole table and grows with it. On the hosted box's 2 GB disk — with
  the nginx lane already budgeting RAM for Postgres — unbounded growth is the
  ceiling this lane removes.
- **The safe frontier exists**: the reporting consumer commits each batch's
  rollup application and the watermark advance in **one transaction**
  (`runConsumerPass.ts` — apply-then-advance is atomic), so every row with
  `id < reporting_outbox_cursor.last_processed_id` for `consumer_name =
  'reporting'` has been durably applied. Webhook delivery retries live on
  `webhook_deliveries` rows (Step A created them per `outbox_event_id` with
  `ON CONFLICT … DO NOTHING`; Step B retries from `webhook_deliveries`), so the
  outbox row has no second life after Step A — except the one real hazard
  below.

### The one hazard (and the gate that handles it)

If Step A never created deliveries for a row (dispatcher down across the whole
retention window, or a merchant had no active endpoint at the time), deleting
the row would permanently lose that webhook. That is why the retention gate
requires **both** the reporting watermark front **and** an age window far
beyond any plausible dispatcher outage (the LISTEN-drop incident
`docs/incidents/dispatcher-listen-drop-2026-10-30.md` was minutes, not days),
plus an optional strict backstop for rows any delivery still references.

### Plan

1. **New script `scripts/purge_outbox.ts`** mirroring the `scripts/` pattern
   (SQL-builder functions exported for unit tests, like `expire_holds.ts` +
   `expire_holds.test.ts`; DATABASE_URL-gated run like
   `reconcile_march.integration.test.ts`). Behavior:
   - Flags: `--dry-run` (print prospective count, delete nothing),
     `--days=90` (retention window), `--batch=10000` (delete loop), and a
     `--strict` flag enabling the backstop below.
   - Core statement (builder function `buildPurgeSql(days, batch)` → `{text,
     values}`; unit-test the SQL shape, exactly the `expire_holds` precedent):
     ```sql
     DELETE FROM outbox_events
      WHERE id < (SELECT last_processed_id
                    FROM reporting_outbox_cursor
                   WHERE consumer_name = 'reporting')
        AND created_at < now() - ($1::int * interval '1 day')
        -- --strict backstop: keep any row a delivery still references
        AND NOT EXISTS (
              SELECT 1 FROM webhook_deliveries wd
               WHERE wd.outbox_event_id = outbox_events.id
            )
      LIMIT $2
     RETURNING id
     ```
     Loop until a batch returns fewer rows than the batch size (idempotent:
     the predicate is monotone, re-runs delete nothing new).
   - **Never run with `--days < 7`**; the default 90 days is the
     recommendation (see open question Q1).
   - Boot guard identical to the other scripts: refuse to run without
     `DATABASE_URL`; warn loudly on dry-run by default? — no: default is the
     safe converse, `--dry-run` is the safe default posture. The implementing
     lane picks the script's default (safe default = print, require explicit
     `--commit`) — decide in implementation, not here.
2. **Scheduling (orchestrator decision, Q2)**: host cron on the box
   (recommended; nothing in compose runs it, per the ops thin-standalone
   precedent) or a pre-demo one-shot. Explicitly **not** folded into the
   settlement Go scheduler (another lane's app) and not into the reporting
   consumer (its pass is event-triggered and its files are JSON/reporting lane
   turf).
3. **New test file** `scripts/purge_outbox.test.ts` (a NEW file — the
   AGENTS.md regression-lock forbids editing existing tests, not adding ones):
   unit-test the builder output (text + values shape, `LIMIT` present, window
   arithmetic correct) and, in the integration test, round-trip synthetic
   rows (insert one fresh, one old-below-watermark, one old-above-watermark,
   one referenced by a delivery) against a scratch DB following the seed-lane
   discipline — never the shared `filspay` database.
4. **No schema change**: no migration needed; `processed_at` stays vestigial
   (documented as-is — repurposing it would touch dispatcher/reporting files
   nobody owns here).

### Benefit / risk

- **Benefit**: bounds table + secondary-index growth on the smallest disk in
  the stack; keeps `idx_outbox_unprocessed` actually partial (it becomes
  mostly-empty as rows age out); each deleted row frees its JSONB payload.
- **Risk**: the never-delivered-row hazard above — handled by watermark + age
  + optional delivery-reference backstop. The `payout_notify.go:38` EXISTS
  guard reads *current* outbox rows during batch close; it is a same-
  transaction dedup guard, so absent *historical* rows cannot affect it — the
  Go suite (`go test ./...`) is in the verification list anyway to prove it.
- **Fail-safe check**: dry-run counts first; `SELECT count(*), max(id),
  pg_size_pretty(pg_total_relation_size('outbox_events'))` before/after; fresh
  capture → dispatcher still creates a delivery; reporting suite still green.

---

## 4. What this lane will NOT do (scope boundary — read this, implementer)

- **No application code edits.** Nothing in `apps/`, `packages/`, `db/seed/`
  is changed by this plan. OPT-1 is a migration only; OPT-2 is a `scripts/`
  addition only. `docs/plans/` is the only directory this lane writes to.
- **No query rewrites** — in particular no edits to the `AT TIME ZONE`
  business-day windows in `apps/api/src/analytics/query.ts:19,306` or
  `apps/api/src/admin/reportingRebuild.ts:27,35`. Index-defeating date-window
  rewrites are the bug-family lanes' scope, are behavior-sensitive (BETWEEN vs
  half-open), and are deliberately not picked up here. The queries OPT-1
  serves (`settlement/query.ts`) are **already** sargable — nothing to fix
  there, only an index to add.
- **No dispatcher / reporting / settlement SQL** — set-based SQL for the
  dispatcher, archive/replay, and the reporting consumer belongs to the
  JSON-in-Postgres lane; `batch.go` belongs to the batch-commit lane; nothing
  here touches their files (the dispatch insert at `dispatcher.ts:122` is
  cited only as context for why outbox rows are safe to retire).
- **AGENTS.md hard rules honored**: no `packages/money/`, no edits to existing
  test files, no monetary-column widening, no `v1/` stub changes, no new
  `WEBHOOK_ELIGIBLE_EVENT_TYPES`, no `refund.succeeded` additions.
- **No matview work**: no matview exists that anything refreshes in-tree
  (grep finds no `REFRESH MATERIALIZED VIEW`); adding a refresh is feature
  work, not optimization, and is out of scope.
- **No runtime / ops changes** (Bun vs tsx, seccomp, PG18, nginx, compose
  WAL/PG tuning) — the io_uring and nginx lanes own those.

---

## 5. Migration & verification steps (for the implementing lane)

Order matters; every step is evidence-gated.

0. **Baseline.** On a scratch migrated DB (fresh migrate must stay 66/66 →
   67/67 after OPT-1; `bun run migrate`): capture `EXPLAIN (ANALYZE, BUFFERS)`
   for `getSettlementSummary` and `getReconciliationReport` against the
   seeded/staging dataset (alpha + a multi-capture merchant), and record
   `SELECT count(*), max(id), pg_size_pretty(pg_total_relation_size(
   'outbox_events'))`. Re-run the two `docs/perf/` scenarios (settlement
   summary; FP-209 export/list/summary) for the before-numbers.
1. **OPT-1**: add `db/migrations/0073_transaction_events_event_type_idx.sql`,
   `bun run migrate` on the scratch DB, re-run the same `EXPLAIN`s. PASS =
   the new index appears in the plan and the summary scenario is not slower
   (FP-209 baseline p50 88 ms). If the plan is unchanged and the cost is
   identical → `DROP INDEX`, close as documented "no". Column-order decision
   (`occurred_at` tail) is made here, from the plan text, not pre-committed.
2. **OPT-2**: write `scripts/purge_outbox.ts` + `scripts/purge_outbox.test.ts`
   (SQL-shape unit tests as in `expire_holds.test.ts`). On the scratch DB:
   insert synthetic rows in all four states (fresh; old & below watermark;
   old & above watermark; old & delivery-referenced), run `--dry-run` and
   assert only the old-below-watermark unreferenced row is counted, then run
   with the commit path and assert exactly that row disappeared.
3. **Regression sweep (repo-wide, per AGENTS.md)**:
   ```
   bun test && cd apps/settlement && go test ./...
   ```
   plus `npx tsc --noEmit` in apps/api and apps/reporting. OPT-1 is DDL-only
   (no TS touched), OPT-2 adds only `scripts/` files — the sweep is to prove
   the *absence* of side effects, especially the `payout_notify.go` EXISTS
   reader and the dispatcher/reporting suites.
4. **Live smoke**: one fresh capture → dispatcher creates the delivery
   (deliveries still appear for new events); reporting consumes it (watermark
   advances); a re-run of the purge deletes 0 rows (idempotence proof).

---

## 6. Risks and fail-safes

- **Index does nothing (biggest for OPT-1)**: the planner may keep the hash
  join at equal cost. Fail-safe: the evidence gate in §5 step 1 — no code
  depends on the index, so dropping it is a no-op revert, not a rollback.
- **Retention deletes a never-delivered webhook**: gated by the 90-day window
  (far beyond the minutes-scale dispatcher incidents on record), the reporting
  watermark (proves durable processing), and the `--strict` delivery-reference
  backstop. Fail-safe: dry-run first, `SELECT` counts before/after, and the
  incident docs say a lost-during-demo webhook replay is rebuildable from
  `webhook_delivery_archives` for archived rows — none of this deletes
  archives (the JSON lane's table is untouched).
- **Watermark never set**: a fresh DB where `reporting_outbox_cursor` has no
  row → the subselect yields NULL → `id < NULL` matches nothing → the purge
  deletes nothing. Fail-safe built into the SQL; the script must also log
  "watermark missing; nothing purged" when that happens.
- **Shared-DB hazard**: the shared `filspay` QA DB must never be purged by
  tests (seed-lane discipline); the new integration test runs on its own
  scratch DB like `reconcile_march.integration.test.ts`.
- **No-regression rule**: every change is behind the §5 gates; a change that
  regresses FP-209 numbers or any suite is reverted, not tuned around.

---

## 7. Verified facts (checked 2026-10-30 in-session)

- Open follow-up + EXPLAIN (seq scan 402,911 rows; hash join 118,204 rows):
  `docs/perf/2026-07-settlement-summary-slow.md:60-61` and EXPLAIN block.
- FP-209 baselines (summary p50 88 ms, list p50 41 ms, export p50 2.21 s;
  RSS idle 171 MB / peak 236 MB): `docs/perf/fp-209-loadtest-2026-09.md`.
- Summary + reconciliation join shapes: `apps/api/src/settlement/query.ts:304-311`,
  `:366-386`; sargable window helper `bahrainLocalMidnightUtc` at
  `:264-271`.
- `idx_transaction_events_transaction (transaction_id, occurred_at)`:
  `db/migrations/0018_transaction_events.sql:23`; event_type CHECK at
  `:14-16`.
- Outbox schema + all-rows partial index:
  `db/migrations/0009_outbox_events.sql:5-15`; watermark table
  `db/migrations/0030_reporting_outbox_cursor.sql:10-14`.
- `processed_at` unowned: `apps/api/src/webhooks/dispatcher.ts:18`;
  `apps/reporting/src/consumer/cursor.ts:5`. Step A reads outbox at
  `dispatcher.ts:93`, inserts deliveries keyed by `outbox_event_id` at
  `:122`; reporting reads by cursor at `runConsumerPass.ts:48`; Go EXISTS
  guard at `apps/settlement/internal/settlement/payout_notify.go:38`.
- No purge exists tree-wide (only the test-fixture delete at
  `apps/reporting/src/consumer/runConsumerPass.test.ts:159`).
- `scripts/` operational pattern: `expire_holds.ts` + `expire_holds.test.ts`
  (SQL-builder unit tests), `reconcile_march.ts` (+ integration test).
- Migration count 66, max `0072`; `0073` is free. Hosted box 2 GB disk per
  `ops/README.md` (Resource sizing), cited in the nginx plan §1.

## 8. Coordination with the in-flight lanes (disjoint scopes)

| Lane | Owns | This plan's touchpoints there |
|---|---|---|
| io_uring | seccomp/PG18/Bun runtime levers | Reads only; OPT-1 is the SQL-side half of the same read-path goal (PG18 async I/O accelerates seq scans; the index removes them where the join needs selectivity); OPT-2 keeps table/index sizes flat for their VACUUM/ANALYZE tests |
| server/nginx | proxy, host PG tuning, Fastify opts | Reads only; OPT-2 is their disk/RAM story's second half — bounded table growth means PG bloat never eats the 2 GB budget their §3.4 tuning assumes |
| batch-commit | `apps/settlement/internal/settlement/batch.go` + tests | Reads only; the 0073 index may also benefit their close-pass reads; the batch-read side of `transaction_events` stays theirs — this lane adds an index, not a query |
| JSON-in-Postgres | `archiveReplay.ts`, `replayBatch.ts`, `docs/design/json-in-postgres-vs-app.md` (dispatcher/reporting set-based SQL) | No file overlap; the delivery-reference backstop reads `webhook_deliveries` but only in a NOT EXISTS predicate — their tables and SQL are untouched; retention never touches `webhook_delivery_archives` |

Write scope of this lane: `docs/plans/db-query-retention-2026-10-30.md` only.
Anything else is out of scope and a defect.

## 9. Open questions (for the orchestrator — not blockers for this document)

1. **Retention window**: 90 days (recommended — order-of-magnitude beyond any
   recorded dispatcher outage) vs 30 days vs a pre-demo one-shot? This decides
   the default `--days`.
2. **Job placement**: host cron vs compose sidecar vs manual pre-demo run?
   `scripts/` + host cron is the recommendation (matches the repo's
   operational-script precedent; no lane-owned app is touched).
3. **`--strict` backstop default**: on by default (safest; keeps
   delivery-referenced rows even past the window) or off by default (frees
   more, relies on the age gate alone)?
4. **May the implementing lane create `db/migrations/0073_*.sql` and new
   `scripts/purge_outbox.ts` / `scripts/purge_outbox.test.ts` files?** (No
   existing file is edited by this plan.)
