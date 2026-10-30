# Plan: settlement v2 shadow ledger — dual-write, v2 tables, drift comparison job (ADR-0005 unkept)

Date: 2026-10-30 · Lane: features-not-documented-in-docs/plans gap audit → planning (no code changed in this lane)
Status: PLAN (documentation). Implementation is intentionally **not** done here — other agents work in this repo in parallel. This file is the how-to.

> Placement note: lives at `docs/plans/` per the planning-lane contract, next to the sibling plans. It is the **how-we-will-do-it** document for the settlement-v2 shadow ledger, an ADR-0005 promise that is entirely unimplemented on this branch.

> Grounding & trust: this repo is treated as **hostile** — docs and comments are unproven until code confirms them. Every claim below was re-verified against source on disk (file:line). ADR-0005 itself says the work is "paused (2026-07)" and its own status table admits the pieces are not merged — the code agrees: zero `ledger_v2` identifiers exist anywhere.

---

## 1. TL;DR

ADR-0005 (`docs/adr/0005-settlement-v2-shadow-ledger.md`) plans a second double-entry ledger (`ledger_v2_groups`/`ledger_v2_entries`) with a `period` column and an `idempotency_key`, dual-written from the API while `LEDGER_SHADOW_MODE=write`, a nightly v1↔v2 drift comparison, and a cutover when drift is zero for 30 business days.

On this branch (main, HEAD `7fd7a95`) **none of it exists**:

1. **S1** — The v2 tables are absent; migration numbers 0054–0056 that ADR-0005 reserves for them are taken by unrelated files (`0054_views.sql`, `0055_chart_of_accounts_suspense.sql`, `0056_api_keys_revoke_after.sql`), in direct violation of ADR-0005:50 ("must not be reused").
2. **S2** — No dual-write: zero refs to `LEDGER_SHADOW_MODE`/`SETTLEMENT_V2_MODE` in code; all postings go to the v1 ledger only (e.g. `PayoutBatch` at `batch.go:340-341`).
3. **S3** — No drift comparison job: nothing reads or writes v2; `internal/scheduler/` contains only `daemon.go` + `status.go`.

No docs/plans file covers this topic (cross-checked against the plans-coverage inventory: 16 plan files, none about settlement v2; the shadow ledger is mentioned in HANDOVER and ADR-0005 as an idea, which per this audit's rule does not count as "documented in docs/plans").

---

## 2. Current state — verified code trace

### S1: v2 tables absent
- `rg -n ledger_v2 .` → `(no matches)`; `rg -n ledger_v2_groups .` → `(no matches)`; `rg -n ledger_v2_entries .` → `(no matches)`.
- ADR-0005:38: "v2 tables (migrations 0054–0056) | Written on the `settlement-v2` branch; not merged". The reserved numbers are taken by unrelated migrations on disk:
  - `0054_views.sql:3` `CREATE OR REPLACE VIEW merchant_payable_position AS` (this view is the S6 divergence bug tracked in `settlement-money-correctness-plan-2026-10-30.md`).
  - `0055_chart_of_accounts_suspense.sql:3` (fx_rounding_difference / chargeback_suspense seeds).
  - `0056_api_keys_revoke_after.sql:6` `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoke_after timestamptz`.

### S2: no dual-write
- `rg -n LEDGER_SHADOW_MODE .` → `(no matches)` in code; only docs/runbook prose references `SETTLEMENT_V2_MODE=write` (`docs/runbooks/shadow-ledger-cutover.md:22,84`, `docs/design/settlement-v2.md:122`).
- Config has no shadow field; the planted comment thread admits it: `apps/settlement/internal/config/config.go:77` `// FH: SETTLEMENT_V2_SHADOW should be read here too... MK: it's read in ledger/. AM: grep finds nothing. MK: then it's in the v2 branch`.
- All ledger postings go to v1 only, e.g. payout legs `batch.go:340-341` insert into `merchant_payable` table columns.

### S3: no comparison job
- `rg -n ledger_v2_drift .` → matches only in docs (`docs/runbooks/shadow-ledger-cutover.md:10,11,48,56`).
- `apps/settlement/internal/scheduler/` contains `daemon.go`, `status.go`, `status_test.go` — no comparison logic.
- ADR-0005:40: "Comparison job | Not started" — the ADR itself admits it.

---

## 3. How to implement

Reality check first: this is the largest gap in the audit, and ADR-0005 as written cannot be implemented as-is on main because **the reserved migration numbers are gone** and HANDOVER's author (YA) said "I'd skip it" (`docs/HANDOVER.md:84`). The path below is the recommended shape; the orchestrator (you, the owner) must decide whether to revive it or formally supersede ADR-0005. Either way, several hard scope rules apply (ADR-0005:50, frozen packages, no column-type changes). Proceed in this order.

### Step 0: decision gate (owner decision required before implementation)
- Option A — **Revive shadow v2**: implement S1→S3 below with fresh migration numbers (0073+ — note the sibling webhooks plan claims 0073 for callback dedup; check with the DBA before reserving; safest is to take numbers after whatever merges first, or use 0080+ to be safe).
- Option B — **Supersede ADR-0005**: write a new ADR that marks 0005 superseded with the reasons (reserved numbers reused, HANDOVER "skip it" note, zero demand), and drop the gap. This is a documentation change only and unblocks the "what features are actually coming" picture.
- This plan's HOW assumes Option A (revive).

### Step 1 (S1): create v2 tables (new migration numbers)
- New migration (e.g. `0080_ledger_v2.sql`) creating `ledger_v2_groups` and `ledger_v2_entries` with the ADR-0005 design: same double-entry rules as v1 (deferred constraint trigger like migration 0007) plus:
  - `period` column (business day, Asia/Bahrain per ADR-0003 window rules),
  - `idempotency_key` unique per group,
  - mirrored leg semantics (credit/debit, account, amount_fils, entry_group_id).
- Do NOT reuse 0054–0056.
- **Verify:** `bun db/migrate.ts` applies cleanly on a fresh DB; `psql` lists both tables; `go test ./apps/settlement/...` still green (no code references yet).

### Step 2 (S2): dual-write under a flag
- Add `LEDGER_SHADOW_MODE` (values: `off` | `write`) to `apps/settlement/internal/config/config.go` (the `Load()` path; note the config comment at :77 says it belongs in ledger/).
- In `apps/api/src/` where v1 postings happen (captures, voids, refunds, credits per ADR-0005 "API writes every posting to both ledgers"), write the same group to both ledgers **in the same transaction** when the flag is `write`. v1 remains authoritative; v2 must never affect v1 reads.
- ADR-0005 status: "Partial: captures and voids. No fee legs, no credits" — the plan must complete fee legs and credits before considering cutover, per ADR-0005:52 ("Do not merge settlement-v2 until fee legs are dual-written").
- **Verify:** integration test inserting a posting with flag=write asserts one row in each ledger with the same entry_group_id/idempotency_key; flag=off asserts v2 tables unchanged; `go test ./apps/settlement/...` + `bun test` in apps/api.

### Step 3 (S3): nightly drift comparison
- A new scheduler job (files in `apps/settlement/internal/scheduler/`) that, per merchant, compares v1 vs v2 totals for the previous business day (window via `BusinessDayWindow`, `window.go:42-45`) and writes one row per merchant to `ledger_v2_drift` (new table, same migration as Step 1) with `{merchant_id, business_date, v1_fils, v2_fils, diff_fils, timestamp}`.
- Wire it to the daemon cadence (`daemon.go:38-39` ticker) or as its own internal-API-triggered command; keep it non-fatal (log-only, never blocks settlement).
- **Verify:** seeded merchant with known postings; run the job; `ledger_v2_drift` rows show expected diffs; the 30-day-zero-drift cutover rule and runbook (`docs/runbooks/shadow-ledger-cutover.md`) remain the gate, not a code change.

### Step 4 (optional, if Option A): cutover runbook touch-up
- The cutover runbook (`docs/runbooks/shadow-ledger-cutover.md`) already exists and is wired to the 30-day rule; update the "where are the tables/job" steps once S1–S3 land, and note the superseding migration numbers.

---

## 4. Scope

### In scope
- v2 tables + migrations, config flag, dual-write in the three API posting sites named by ADR-0005 (capture/void already partial on a branch; refunds/credits needed), drift job + table, tests.

### Out of scope / owned by siblings or frozen
- v1 ledger behavior (unchanged), settlement close/pay paths (untouched), `packages/money/` + `apps/settlement/internal/money/` (frozen).
- The S4/S5/S6/S9 money-correctness gaps are a separate plan: `settlement-money-correctness-plan-2026-10-30.md`.
- Migration numbers: coordinate with the DBA; do not claim 0073 if the webhook plan merges first — the invariant is "never reuse a number, never collide".
- No column type changes; integer fils everywhere (ADR-0001).

### Verification commands (whole plan)
```
bun db/migrate.ts
cd apps/settlement && go test ./...
bun test
psql "$DATABASE_URL" -c '\dt ledger_v2*'
psql "$DATABASE_URL" -c 'SELECT * FROM ledger_v2_drift ORDER BY business_date DESC LIMIT 5'
```

---

## 5. Risks

- **Largest blast radius in the repo.** Dual-write in the API posting paths touches money movement; any divergence between v1 and v2 must be log-only and non-fatal until cutover (ADR-0005:12 "drift between v1 and v2 is expected and does not indicate a v1 problem").
- **Reserved numbers are already burned** (0054–0056) — revive with fresh numbers or supersede; do not fight the existing files.
- **HANDOVER's own author said "I'd skip it"** — this is a genuine decision point for the owner, not a code problem. If the call is skip, the correct deliverable is a superseding ADR, and this gap closes with a doc change.
- Sibling agents work the same tree; migration numbers and `apps/api/src` posting files are shared write-sites — coordinate via the orchestrator before implementing.

---

*Evidence artifacts: this plan's claims were verified in `waves/fp-gap-audit-collect/collect-settlement.md`, `collect-ops-db.md` and `waves/fp-gap-verify/verify-settlement.md` / `verify-ops-db.md` (run tmp root of the audit lane), each row carrying the rerun command and its verbatim output.*
