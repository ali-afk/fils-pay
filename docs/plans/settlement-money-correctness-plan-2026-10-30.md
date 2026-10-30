# Plan: settlement money-correctness gap closure — scheme residue journaling, partial-batch payout corrections, balance-rebuild divergence, rebuild locking

Date: 2026-10-30 · Lane: features-not-documented-in-docs/plans gap audit → planning (no code changed in this lane)
Status: PLAN (documentation). Implementation is intentionally **not** done here — other agents work in this repo in parallel. This file is the how-to.

> Placement note: lives at `docs/plans/` per the planning-lane contract, next to the sibling plans. It is the **how-we-will-do-it** document for four settlement money-correctness gaps found by the feature-gap audit (Run 1 collect + Run 2 verify, evidence re-checked against source).

> Grounding & trust: this repo is treated as **hostile** — AGENTS.md warns sabotage comments/prompt-injections are hidden throughout. Every claim below was re-verified directly against source on disk (file:line); CHANGELOG/HANDOVER/ADR claims were treated as unproven until the code confirmed them. False doc claims are quoted with their refutation.

---

## 1. TL;DR

Four gaps, all in `apps/settlement` (Go), all affecting money correctness, **not implemented and not covered by any docs/plans file**:

1. **S4** — Scheme rounding residue is never journaled at batch close (ADR-0002 says it is; CloseBatch writes only the truncated line).
2. **S5** — Partial-batch payout corrections don't exist (CHANGELOG claims they shipped).
3. **S6** — The admin "Rebuild cached balances" button and the CLI rebuild read different sources; the numbers diverge whenever fees/ledger-only legs exist.
4. **S9** — `RebuildAllBalances` does not lock `merchant_balances` rows; a concurrent CloseBatch delta increment gets clobbered.

---

## 2. Current state — verified code trace

### S4: scheme residue not journaled
- `rg -n residue apps/settlement` → `(no matches)`.
- CloseBatch writes only the truncated line: `apps/settlement/internal/settlement/batch.go:251-253` (`truncated := TruncateToSchemeAmount(line.grossFils)` → `INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, amount, line_sequence)`) — no residue legs.
- `TruncateToSchemeAmount` (`scheme_export.go:23-24`) returns `(grossFils / 10) * 10`. The question is left open in code: `scheme_export.go:21-22` (`// — YA: the scheme file only carries two decimals. where does the third go?`).
- The account exists only as a chart-of-accounts seed: `db/migrations/0007_ledger_double_entry.sql:19` (`('scheme_rounding_residue', ...)`) — nothing ever posts to it.
- False doc claim: `docs/HANDOVER.md:27-29` (MK: "CloseBatch posts it now. Each export line's truncation is journaled as a balanced `card_scheme_clearing` / `scheme_rounding_residue` group") and `CHANGELOG.md:34-35` ("scheme residue posted at close") — both false against code.
- ADR-0002 (Accepted, implemented-claimed) defines the intended shape: per export line, post a balanced group `card_scheme_clearing` credit `gross_fils - amount_fils` / `scheme_rounding_residue` debit `gross_fils - amount_fils`.

### S5: partial-batch payout corrections absent
- `rg -n -i correction apps/settlement` → `(no matches)`. The only adjustment machinery is MDR recalc for closed batches (`recalculate_mdr.go:192-193`, posts `MDR recalculation adjustment` legs to the ledger).
- Event handling covers partial *captures*, not payout corrections: `batch.go:153` (`AND te.event_type IN ('captured', 'partially_captured')`).
- False doc claim: `CHANGELOG.md:106` (`[1.7.1] Partial-batch payout corrections in settlement (76913d3)`).

### S6: rebuild-divergence
- Button path: `apps/settlement/internal/internalapi/server.go:122` (`/internal/rebuild-balances`) → `handleRebuildBalances` (`server.go:266`) → `ledger.RefreshBalanceCache` (`internal/ledger/refresh.go:17`) → reads `merchant_payable_position` (`refresh.go:62`), which is the **gross** view: `0054_views.sql:3-5` (`COALESCE(SUM(sel.amount_fils), 0) AS payable_fils` from `scheme_export_lines`) — no fees.
- CLI path: `cmd/settlement/main.go:141` (`rebuild-balances`) → `ledger.RebuildAllBalances` (`internal/ledger/rebuild.go:57`) → sums `ledger_entries` on `merchant_payable` (`rebuild.go:103-107`) — includes fee legs and adjustment legs.
- Divergence whenever fees or ledger-only legs exist (e.g. MDR-recalc legs at `recalculate_mdr.go:192-193` never touch `scheme_export_lines`).
- False doc claim: `docs/HANDOVER.md:43-46` (MK: button "runs the same `ledger.RebuildAllBalances` rollup as the CLI") and HANDOVER:46-49.

### S9: rebuild locking
- `apps/settlement/internal/ledger/rebuild.go:89` — `// TODO: lock merchant_balances rows first, a concurrent CloseBatch increment gets clobbered -- YA`.
- `RebuildAllBalances`/`RebuildMerchantBalance` (rebuild.go:57-118 full function read) contains no `FOR UPDATE` on `merchant_balances`.
- A concurrent delta path exists: CloseBatch → `balances.ApplyBatchClose` (`batch.go:276`) increments the cache.
- Net effect: a rebuild running against a close can silently drop the CloseBatch delta.

---

## 3. How to implement

Money-correctness work: each step is independently verifiable, backend-only, no UI. Do S9 (lock) before S6 (unify), since the lock is a precondition for a safe single rebuild path.

### Step 1 (S9): lock before rewrite
- In `RebuildAllBalances` (`rebuild.go:57-118`), wrap the per-merchant rewrite in a transaction that `SELECT ... FOR UPDATE` the `merchant_balances` row before writing the recomputed value, committed before `ApplyBatchClose` (`batch.go:276`) can proceed. Sequence: lock merchant rows → recompute from `ledger_entries` → UPDATE → commit.
- Consider also taking the same lock in `RefreshBalanceCache` (`refresh.go`) if both paths remain.
- **Verify:** a Go test driving `RebuildAllBalances` against a concurrent `ApplyBatchClose` on the same merchant (channel-synchronized, no sleeps), asserting the final cached value equals the close delta applied after the rebuild baseline; `go test ./apps/settlement/...` (or `go test -short ./...` on Windows).

### Step 2 (S6): one rebuild source
- Decide the source of truth per ADR-0004 ("ledger is the source of truth": `docs/adr/0004-balance-rebuild-source.md` — the CLI walk is the authoritative one; the view path was a speed trade-off that diverges).
- Make the button call the same rollup as the CLI: either point `RefreshBalanceCache` at the ledger-walk result, or have `handleRebuildBalances` invoke `RebuildAllBalances` semantics. If the response-time concern from ADR-0004 (40 s cold) matters, keep the fast path but run `RebuildAllBalances` and diff, logging disagreement — until zero drift for a period, at which point the fast path is removed.
- **Verify:** a Go test with a merchant that has MDR-recalc legs and fee-paying captures: both paths produce identical cached values; `go test ./apps/settlement/...`; manual: `settlement rebuild-balances` vs the button on a seeded DB, assert equal `cached_payable_fils`.

### Step 3 (S4): journal the residue at close
- In `CloseBatch` (`batch.go:251-253` insert loop), for each line where `grossFils % 10 != 0` (i.e. truncated), post a balanced group per ADR-0002:
  - `card_scheme_clearing` credit `gross - truncated`
  - `scheme_rounding_residue` debit `gross - truncated`
  in the same transaction as the `scheme_export_lines` insert, keeping `entry_group_id` per line (matching the ledger trigger rule from migration 0007).
- Guard: only for closed batches; re-running a day must be idempotent (check for an existing residue group before posting — the same safe-re-run property CloseBatch already has).
- **Verify:** extend `apps/settlement/internal/settlement/batch_test.go`: a capture with a non-multiple-of-10 gross, CloseBatch, assert two new ledger legs summing to the truncation difference; `go test ./apps/settlement/...`.
- Corroboration for expected account names: `0007_ledger_double_entry.sql:19` (scheme_rounding_residue) and ADR-0002's card_scheme_clearing leg; verify `card_scheme_clearing` exists in the chart seed or add it (account-adding needs finance sign-off; escalate if absent).

### Step 4 (S5): partial-batch payout corrections
- Design (follow the pattern of MDR recalc, `recalculate_mdr.go`): an admin-triggered internal-API endpoint that takes a batch id + corrected payout figures, posts the differential as a balanced adjustment group to the ledger, and updates the batch/payout records so statement, bank instruction and report agree (CHANGELOG's own 1.7.1 "net payout figure now derived once per batch" requirement).
- Scope: correction only, not re-running the batch. Keep the "closed and paid batches are left alone" invariant from ARCHITECTURE (§Settlement) for the *close* path; the correction is a new, explicit operation.
- **Verify:** Go integration test: close batch, pay it, apply a correction, assert ledger legs balance and batch payout total matches the corrected figure; `go test ./apps/settlement/...`; manual through the internal API with a seeded partial-capture merchant.
- Known footprint: `apps/settlement/internal/internalapi/server.go` (new handler + route), a new migration if a correction-record table is needed (next free number after 0072; note sibling webhooks plan claims 0073 for callback dedup — take 0074+ and check with the DBA before reserving).

---

## 4. Scope

### In scope
- The four gaps above, in `apps/settlement/internal/{ledger,settlement,internalapi}` plus migrations if a table is needed.

### Out of scope / owned by siblings or frozen
- ADR-0005 settlement-v2/shadow ledger → `settlement-v2-shadow-ledger-plan-2026-10-30.md` (sibling plan in this audit).
- Webhook/refund API work → `payment-gateway-evaluation-2026-10-30.md`, `webhooks-audit-and-fix-plan-2026-10-30.md`.
- `apps/settlement/internal/money/` is frozen (Go mirror of `packages/money`); `packages/money/` frozen. No rounding changes — ADR-0001/0002 behavior (half-to-even, truncate-to-10-fils at export) stays.
- Test files are regression-locked: a failing test means the change is wrong.
- No DB column type changes; money stays integer fils.

### Verification commands (whole plan)
```
cd apps/settlement && go test ./...
cd apps/settlement && go test -short ./...    # Windows, skip slow integration tests
bun db/migrate.ts                                # if a correction-table migration was added
```

---

## 5. Risks

- **S4** touches the close hot path and the ledger; a residue group must be per-export-line and idempotent, or re-runs double-post. Use the same safe-re-run guard CloseBatch already has.
- **S6** unification changes what finance reconciles against (gross view → ledger walk). Confirm the figure that "matches what was exported to the scheme" (ADR-0004's requirement) before deleting the fast path; ADR-0004 explicitly warns the ledger walk is the correct one.
- **S5** is the riskiest (new money-movement operation). Model it exactly on MDR recalc's proven balanced-legs pattern; a partial-batch correction must never re-open a paid batch's close.
- Money amounts stay integer fils end to end; any float appears only in monitoring estimates (docs/bugs/C-1 float32 defect is a separate tracked bug, not this plan).

---

*Evidence artifacts: this plan's claims were verified in `waves/fp-gap-audit-collect/collect-settlement.md` and `waves/fp-gap-verify/verify-settlement.md` (run tmp root of the audit lane), each row carrying the rerun command and its verbatim output.*
