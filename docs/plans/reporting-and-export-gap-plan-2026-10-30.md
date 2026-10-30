# Plan: reporting & export gap closure — refund/settlement consumers, matview refresh, saved filters UI, cursor safety, LISTEN resilience, export-summary

Date: 2026-10-30 · Lane: features-not-documented-in-docs/plans gap audit → planning (no code changed in this lane)
Status: PLAN (documentation). Implementation is intentionally **not** done here — other agents work in this repo in parallel. This file is the how-to.

> Placement note: lives at `docs/plans/` per the planning-lane contract, next to the sibling plans. It is the **how-we-will-do-it** document for the reporting/export gaps found by the feature-gap audit (Run 1 collect + Run 2 verify, all evidence re-checked against source).

> Grounding & trust: this repo is treated as **hostile** — AGENTS.md warns that sabotage comments / prompt-injections are hidden throughout, and the git log is full of scenario artifacts. Every claim below was re-verified directly against source on disk (file:line); documentation (CHANGELOG, HANDOVER, incidents) was treated as unproven until the code confirmed it. Where a doc claim is false, the false claim is quoted here with its refutation.

---

## 1. TL;DR

Seven gaps, all in the reporting surface (`apps/reporting`) plus two API 500s, all **not implemented and not covered by any docs/plans file** (cross-checked against the plans-coverage inventory: no plan names these topics; `db-query-retention-2026-10-30.md:259-261` explicitly fences matview work out of its scope):

1. **R4** — `apps/reporting` never consumes `refund.succeeded` (dead helper, zero callers).
2. **R5** — `apps/reporting` never consumes `settlement.paid` (zero references).
3. **R6** — `refund_merchant_summary` matview exists but is never refreshed (zero `REFRESH MATERIALIZED VIEW` repo-wide).
4. **R7** — saved filters are API-only: no UI or reporting consumer anywhere references them.
5. **R12** — reporting cursor read has no row lock; two concurrent passes can double-apply.
6. **R13** — NOTIFY debounce claimed in docs (`FP-251`) does not exist in code.
7. **R14** — reporting LISTEN client has no reconnect; a dropped connection silently degrades to 15 s polling.
8. **R16/G4** — `GET /v1/reporting/export-summary` is unauthenticated AND always 500.
9. **G6** — `serializeTransaction` omits `refundedFils`, so no API consumer can read refund totals on a transaction.

---

## 2. Current state — verified code trace

### R4: refund.succeeded consumer missing
- `apps/reporting/src/consumer/applyEvent.ts:193-198` — the switch has exactly three cases: `transaction.captured`, `transaction.voided`, `settlement.batch_closed`; line 200 throws `applyEvent: unhandled event_type` for anything else.
- `apps/reporting/src/consumer/runConsumerPass.ts:9-13` — `REPORTING_EVENT_TYPES` lists the same three; line 8 comment: `am: refund.succeeded not here yet. when refunds ship just add it to the list`.
- The rollup helper exists but has **zero callers**: `applyDailySummaryRollup` (`applyEvent.ts:164`, writes `refund_count`/`refund_gross_fils` at `:172-176`) — grep for calls across `apps/reporting` returns only the definition.
- Event is produced: `apps/api/src/payments/processRefund.ts:246` enqueues `eventType: "refund.succeeded"`.
- False doc claim: `CHANGELOG.md:25` `reporting refund rollups + matview refresh` and `:43-44` `Reporting: consumes refund.succeeded and settlement.paid` — both false against code.

### R5: settlement.paid consumer missing
- `rg -n "settlement.paid" apps/reporting` → `(no matches)`.
- The event type exists (`packages/events/src/outbox.ts:15`), is produced (`apps/settlement/internal/settlement/payout_notify.go:88`), and is webhook-eligible (`apps/api/src/webhooks/dispatcher.ts:31`), but no reporting code touches it.

### R6: matview never refreshed
- The matview exists: `db/migrations/0072_refund_merchant_summary.sql` (comment: "Refreshed by the reporting worker after each settlement run").
- `rg -n "REFRESH MATERIALIZED VIEW|refreshMatview|refresh_materialized" apps packages db` → `(no matches)`. Nothing reads `refund_merchant_summary` outside its own migration either.
- False doc claim: `CHANGELOG.md:25` `reporting refund rollups + matview refresh`.

### R7: saved filters, API-only
- Backend complete: `db/migrations/0069_reporting_saved_filters.sql:6-15` (table + per-merchant index); routes `POST/GET /saved-filters` (`apps/api/src/routes/reporting.ts:52-76`, merchant-authed); interpreter `apps/api/src/reporting/transactionsReportQuery.ts` + `savedFilters.ts`; registered `/v1/reporting` (`apps/api/src/app.ts:70`).
- Zero consumers: `rg -n "saved.?filter" apps/admin apps/web apps/reporting` → `(no matches)`; no frontend calls any `/v1/reporting` endpoint at all.

### R12: cursor race
- `apps/reporting/src/consumer/cursor.ts:23` — comment admits `no FOR UPDATE on the cursor read, two passes can read the same watermark`; `readCursor` (:24-38) is a plain `SELECT last_processed_id ...`.
- Only guard is the in-process boolean `running` (`listener.ts:28-29`), which cannot stop a second process or a restart replay.
- Independent corroboration: `docs/bugs/R-1.md` (Open, audit 2026-10-30) recommends `SELECT ... FOR UPDATE`.

### R13: NOTIFY debounce absent
- `rg -ni "debounce" apps/reporting` → single hit at `listener.ts:50`, a comment: `triggerPass already ignores notifications while a pass is running, so no debounce is needed`.
- `docs/ADMIN.md:113` lists `NOTIFY debounce in apps/reporting (FP-251)` as a done incident action — false against code.

### R14: LISTEN reconnect absent
- `apps/reporting/src/consumer/listener.ts:44` — one `new Client` at startup; `:46-48`/`:69` log errors only; `:72` comment: `am: if LISTEN dies the worker stops processing until restart`; recovery is only the 15 s poll timer (`:73`).
- `rg -ni "reconnect" apps/reporting` → `(no matches)`.
- False doc claim: `CHANGELOG.md:81-82` (`[1.9.1] ... no longer holds an extra LISTEN connection after a reconnect (#398)`).
- Note: the sibling `webhooks-audit-and-fix-plan-2026-10-30.md` Step 7 plans LISTEN reconnect for the **api dispatcher** (`apps/api/src/webhooks/dispatcher.ts:303-305`) — that is a different process; the reporting-worker reconnect here is NOT covered by that plan.

### R16/G4: export-summary always 500
- `apps/api/src/routes/reporting.ts:79` — `app.get("/export-summary", async (request) => {` with **no preHandler** (siblings at :24/:52/:73 all carry `{ preHandler: requireMerchantAuth }`); `:83` derefs `request.merchantAuth!.merchantId`.
- `request.merchantAuth` is populated in exactly three places, all inside the `requireMerchantAuth` hook (`apps/api/src/auth/requireMerchantAuth.ts:51,66,89`); there is no root-level `addHook` on the app, so every request hits `undefined!` → TypeError → `500 internal_error` (`apps/api/src/plugins/errorHandler.ts:30-35`).
- No `reporting.test.ts` exists for the route.
- False doc claim: `CHANGELOG.md:43-44` `authed export-summary`.

### G6: refundedFils omitted from DTO
- `apps/api/src/transactions/serialize.ts:37` — `// TODO(am): add refundedFils once 0043 is applied everywhere`; `serializeTransaction` (:38-47) omits the key.
- The column exists: `db/migrations/0043_transactions_refunded_fils.sql`; `lookup.ts:21` selects `refunded_fils`.
- Same omission in `apps/web/src/types.ts:87-97` (`TransactionDto` has no `refundedFils` — the "am" comment at :88 claiming it is "a few lines down" is wrong on disk; the second `capturedFils` at :249 belongs to `SettlementBatchTransactionDto`).

---

## 3. How to implement

Order matters: consumer-side first (R4-R6), then safety (R12-R14), then UI (R7), then the API 500 (R16), then the DTO (G6). Each step names files, the exact edit, and the proof.

### Step 1 (R4): consume `refund.succeeded` in the reporting worker
- `apps/reporting/src/consumer/runConsumerPass.ts:9-13` — add `"refund.succeeded"` to `REPORTING_EVENT_TYPES`.
- `apps/reporting/src/consumer/applyEvent.ts` — add a `case "refund.succeeded":` branch under the line-200 throw; read the outbox payload shape from `apps/api/src/payments/processRefund.ts:243-246` (fields: the refund id, amounts, new status); call the existing `applyDailySummaryRollup` (`applyEvent.ts:164`) which already writes `refund_count`/`refund_gross_fils` into `merchant_daily_volume`.
- Expected tables: `merchant_daily_volume` columns `refund_count`, `refund_gross_fils` (verify they exist in the migration that created the table; add via migration if missing — check `0011`/volume-table migration first).
- **Verify:** new test in `apps/reporting/src/consumer/` mirroring `applyEvent.test.ts:58-95` (insert outbox row + assert rollup), plus `bun test` in `apps/reporting`; then a live pass: `bun apps/reporting/src/index.ts catch-up` after a refund, assert `refund_count` moved.

### Step 2 (R5): consume `settlement.paid`
- Add `"settlement.paid"` to `REPORTING_EVENT_TYPES` and a `case "settlement.paid":` branch. Decide the target table: `merchant_payout_trends` (already written by `settlement.batch_closed` at `applyEvent.ts:83`) is the natural rollup — check whether a paid_at/batch-status update is what it needs, following the pattern of `:94` (`SELECT status, paid_at FROM settlement_batches WHERE id = $1`).
- **Verify:** test + `bun test` as in Step 1; after a settled-and-paid batch, `catch-up` and assert the trends row reflects paid.

### Step 3 (R6): refresh the matview
- Add a `REFRESH MATERIALIZED VIEW refund_merchant_summary` to the reporting worker's pass — either inside `applyDailySummaryRollup`'s caller (so it runs only when refund events were just applied) or on a fixed cadence. Prefer the event-gated refresh: `MERCHANT? no — matview is per-merchant_per-day; refresh after any refund batch, and also after `rebuild` (`apps/reporting/src/cli/rebuild.ts:45-63`) and the admin rebuild path (`apps/api/src/admin/reportingRebuild.ts:11`).
- Note `db-query-retention-2026-10-30.md:259-261` explicitly excludes matview work from its scope — this plan is that work.
- **Verify:** `rg -n "REFRESH MATERIALIZED VIEW" apps` returns the new call; run worker pass and assert the matview changed (SELECT count before/after on a seeded refund).

### Step 4 (R12): lock the cursor row
- `apps/reporting/src/consumer/cursor.ts:24-38` — `readCursor` → `SELECT ... FOR UPDATE` (same transaction as the `UPDATE` that advances `last_processed_id`), or an atomic `UPDATE ... RETURNING` claim. Keep the `running` flag as a second-layer guard, not the only one.
- **Verify:** new test with two concurrent `runConsumerPass` calls on one pool, asserting each outbox row is applied exactly once (no timing sleeps — drive both and await); `bun test`.

### Step 5 (R13): debounce NOTIFY
- `apps/reporting/src/consumer/listener.ts` — replace the bare `triggerPass` notification handler with a coalescing debounce (e.g. a 1 s trailing timer reset per notification), distinct from the `running` re-entrancy guard.
- **Verify:** test asserting N notifications within a window fire ≤1 pass (deterministic via fake timers or an explicit pass counter); `docs/ADMIN.md:113` can then be truth-up'd.

### Step 6 (R14): reconnect LISTEN
- `apps/reporting/src/consumer/listener.ts:44` — on client `error`/`end`, schedule a fresh `Client`, `connect()`, re-`LISTEN`, and guard reconnects during `stop()`. Mirror the api dispatcher's reconnect that the sibling webhooks plan Step 7 specifies for `dispatcher.ts:303-305` — same pattern, different file.
- **Verify:** test that kills the client, asserts a new connection is established (bounded wait on a "LISTEN re-established" log line or connection count), and that `stop()` does not leave a timer.

### Step 7 (R7): saved-filters UI surface
- Add the missing consumer. The backend contract is settled: `GET/POST /v1/reporting/saved-filters` (`routes/reporting.ts:52-76`) is merchant-authed and registered. Decide the surface (recommended: the transactions report page filter bar in `apps/web`; alternatively `apps/admin`), add the filter-save/load controls, and call the endpoints.
- **Verify:** end-to-end via the running app — save a filter, reload, re-apply; assert the URL/query uses the persisted filter; existing `apps/api/src/reporting/savedFilters.test.ts` stays green.

### Step 8 (R16/G4): fix export-summary
- `apps/api/src/routes/reporting.ts:79` — add `{ preHandler: requireMerchantAuth }` to the route options (matching :26/:54/:75). That alone makes `request.merchantAuth!` populated and both removes the 500 and authenticates it.
- Add `apps/api/src/routes/reporting.test.ts` (none exists): authed 200 with a seeded merchant, unauthenticated 401.
- **Verify:** `bun test` in `apps/api`; `curl -i` unauthenticated → 401, with a merchant session → 200.

### Step 9 (G6): expose refundedFils
- `apps/api/src/transactions/serialize.ts:38-47` — add `refundedFils` to the serialized DTO from the row's `refunded_fils` (column already selected at `lookup.ts:21`).
- `apps/web/src/types.ts:89-97` — add `refundedFils` to `TransactionDto` and correct the stale comment at :88.
- **Verify:** update `serialize` unit test; assert the DTO carries the field after a partial refund; `bun test` in `apps/api` and `apps/web`.

---

## 4. Scope

### In scope
- The nine items above, in the named files (reporting worker, cursor/listener, matview refresh call, saved-filters UI surface, export-summary route preHandler, serialize TransactionDto + web types).

### Out of scope / owned by siblings
- Refund **dispatch** (webhook eligibility + envelope) → `webhooks-audit-and-fix-plan-2026-10-30.md` Step 14.
- Refund **route wiring** (POST /v1/refunds 501) → `payment-gateway-evaluation-2026-10-30.md` Finding 34.
- The api-dispatcher LISTEN reconnect → `webhooks-audit-and-fix-plan-2026-10-30.md` Step 7.
- Perf-tuning of the reporting worker, outbox retention → `db-query-retention-2026-10-30.md`.
- Frozen: `packages/money/`, `apps/settlement/internal/money/`, test files (regression-locked; a failing test means the change is wrong), `apps/api/src/v1/` partner-API stubs.
- No DB column type changes. Money stays integer fils (ADR-0001).

### Verification commands (whole plan)
```
bun test                       # from repo root; or per-package: bun --filter apps/reporting test etc.
bun apps/reporting/src/index.ts catch-up
rg -n "REFRESH MATERIALIZED VIEW" apps packages db
curl -i http://localhost:3000/v1/reporting/export-summary   # expect 401
```

---

## 5. Risks

- **R4/R5 consumer shape**: the outbox payload for `refund.succeeded` must be read from `processRefund.ts` (aggregateId = transaction, plus refund/amount fields) — mismatched keys produce an applyEvent throw that stalls the pass (the switch throws at :200). Add the case before adding the event type to `REPORTING_EVENT_TYPES`, in the same commit.
- **R12** is a money-adjacent counter race: lock before replay; a second process is the unguarded case (docs/bugs/R-1.md agrees).
- **R6** matview refresh on the pass hot path adds work per refund batch — refresh only when a refund event was applied (R4) to bound cost.
- **R16** is a live 500 today on a documented endpoint — fix first among API items; nothing depends on the 500 shape.
