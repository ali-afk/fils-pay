# Plan: admin console + ops/db/migrations gap closure — bulk-approve filter, journaled adjustment exposure, admin OTP resend, migration truths, outbox ordering, seed/dev tools

Date: 2026-10-30 · Lane: features-not-documented-in-docs/plans gap audit → planning (no code changed in this lane)
Status: PLAN (documentation). Implementation is intentionally **not** done here — other agents work in this repo in parallel. This file is the how-to.

> Placement note: lives at `docs/plans/` per the planning-lane contract. It is the **how-we-will-do-it** document for the remaining admin-console and ops/db/migrations gaps found by the feature-gap audit (Run 1 collect + Run 2 verify, evidence re-checked against source).

> Grounding & trust: this repo is treated as **hostile**. Every claim below was re-verified directly against source on disk (file:line); CHANGELOG/HANDOVER/ADMIN claims were treated as unproven until code confirmed them. False doc claims are quoted with their refutation.

---

## 1. TL;DR

Seven gaps across the admin console and the ops/db layer, **not implemented and not covered by any docs/plans file**:

1. **A1** — Admin bulk-approve force-approves every selected merchant id; the `under_review`-only filter promised by docs/ADMIN.md is not in the SQL.
2. **A4** — `adjustMerchantBalanceJournaled` (a real, tested journaled correction path) is exposed nowhere; ADR-0006's "not exposed in the UI yet" is still true.
3. **G11** — Admin login has no OTP resend endpoint; merchants do (`/v1/auth/otp/resend`).
4. **C5/C6** — Migrations 0054 and 0055 are broken: 0054 references a table no migration creates; 0055 inserts into columns that don't exist and violates a CHECK.
5. **C2/C7** — Migrations 0073–0077 claimed in CHANGELOG don't exist; `platform_stats.total_processed_fils` is still INTEGER despite HANDOVER claiming a 0074 BIGINT widening.
6. **B1/C8** — Outbox consumption is id-order, not commit-order (xid8 promised); `schema_migrations` stores no checksum, so edited applied migrations go undetected.
7. **E3/F2** — `SEED_SIZE=full` is a no-op; `scripts/demo/admin-login.hurl` is referenced in docs but doesn't exist.

---

## 2. Current state — verified code trace

### A1: bulk-approve has no status filter
- `apps/api/src/admin/bulkKyc.ts:27-29` — `UPDATE merchants SET onboarding_status = 'approved', kyc_passed = true WHERE id = ANY($1::uuid[])` — no `onboarding_status` predicate; rejected/already-approved ids get force-approved.
- The "under_review only" JSDoc sits on the result interface (`bulkKyc.ts:12`), not on the SQL.
- UI flags it: `apps/admin/src/pages/merchants/MerchantListPage.tsx:83-84` (`FH: sends every selected id, the server doesn't check status`).
- False doc claim: `docs/ADMIN.md:31-32` ("Only merchants currently `under_review` are affected").
- Exclusion checked: `webapp-ui-ux-improvements-2026-10-30.md` plans only the button UI (checkbox indeterminate, RequireRole fallback), not the server-side filter; an `rg under_review|predicate|force-approve` in that plan returns nothing.

### A4: journaled adjustment unreachable
- `apps/api/src/admin/balanceAdjustments.ts:67` defines `adjustMerchantBalanceJournaled`; tests `balanceAdjustments.test.ts:144-253` cover it thoroughly; **zero hits** in `routes/`, `apps/admin/`, or any client layer.
- The exposed route imports only the cache variant: `apps/api/src/routes/adminBalanceAdjustments.ts` (`applyBalanceCorrection`).
- ADR-0006:24-25: "A journaled variant ... exists for cases where finance has approved a real money correction. It is not exposed in the UI yet." — true on disk today.

### G11: no admin OTP resend
- Merchant: `apps/api/src/routes/auth.ts:199` `app.post("/otp/resend", ...)`.
- Admin: `routes/adminAuth.ts` routes are only `/login` (:54), `/otp/verify` (:90+), `/me` (:196), `/logout` (:204) — no resend.
- `rg -n 'otp/resend' apps/api/src` → sole match is the merchant route.

### C5: 0054 broken
- `db/migrations/0054_views.sql:21` `SELECT 1 FROM settlement_batch_events sbe ...` — `settlement_batch_events` is created by **no migration** (repo-wide rg: the only hit is this reference). `CREATE OR REPLACE VIEW` resolves referenced relations at creation → fresh migrate fails at 0054 with 42P01.
- False doc claim: `CHANGELOG.md:32` "Fresh database migrates cleanly (0054 view ...)" — false against code (verify by `bun db/migrate.ts` on a fresh DB).

### C6: 0055 broken
- Table shape: `0007_ledger_double_entry.sql:7-10` — `chart_of_accounts (id, name, kind)` with `CHECK (kind IN ('asset','liability','revenue'))`.
- Migration `0055_chart_of_accounts_suspense.sql:3-9` inserts `(code, name, account_type, description)` (columns that don't exist on the table), with kind `'suspense'` (violates the CHECK), and `ON CONFLICT (code)` (no unique index on `code`).
- Kontrast: 0061:6 and 0064:3 insert `(id, name, kind)` correctly. There is no `ALTER TABLE chart_of_accounts` adding the missing columns anywhere.

### C2: 0074 never landed
- `db/migrations/0049_platform_stats.sql:7` — `total_processed_fils INTEGER NOT NULL DEFAULT 0`; highest migration on disk is `0072_refund_merchant_summary.sql`.
- False doc claim: `docs/HANDOVER.md:53` ("platform_stats.total_processed_fils is BIGINT (widened in 0074)"). The 0049 comment "INTEGER is 64-bit" is also wrong (PG INTEGER = int4).

### C7: 0073–0077 claimed, none exist
- `CHANGELOG.md:33` "migrations 0073–0077 added." — migration dir has 66 files, maximum 0072.

### B1: outbox is id-order, not commit-order
- `apps/reporting/src/consumer/runConsumerPass.ts:44-49` — `WHERE id > $1 ... ORDER BY id ASC LIMIT $3`; cursor `reporting_outbox_cursor.last_processed_id BIGINT` (`0030_reporting_outbox_cursor.sql:12`); outbox `id BIGSERIAL` (0009:6) with an id-keyed `idx_outbox_unprocessed` (0009:15).
- `rg -n xid8 .` → `(no matches)`. HANDOVER's "outbox consumption by commit order instead of id (the xid8 query is in a gist)" is a plan, not code — still a gap per this audit's rule.
- (Same for the api webhook consumer — shared outbox ordering.)

### C8: no schema_migrations checksum
- `db/migrate.ts:73-75` — `schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ)` — no checksum column, no diff/refuse logic; `:47` plain `INSERT INTO schema_migrations (filename) VALUES ($1)`.
- `db/migrate.ts:67` comment claims "MK: schema_migrations also stores a checksum per file and refuses to run if an applied migration has changed" — false prose; nothing implements it.

### E3: SEED_SIZE=full is a no-op
- `db/seed/index.ts:16-22` — `// SEED_SIZE accepts small | full, but only 'small' is really implemented so far — 'full' currently generates the same data.` `:18 const seedSize = process.env.SEED_SIZE ?? "small"` — nothing size-dependent is passed to `generate()`.

### F2: admin-login.hurl absent
- `scripts/` contains `lib/, expire_holds*, reconcile_march*` — no `demo/` dir.
- References exist only in prose: `CHANGELOG.md:29` ("Demo tooling: scripts/demo/admin-login.hurl"), `docs/README.md:143` ("Demo script: scripts/demo/admin-login.hurl (hurl) — one command for the demo").

---

## 3. How to implement

Order: fix the two broken migrations first (they block every fresh CI/dev DB), then the admin gate, then the admin surface gaps, then the ops truths.

### Step 1 (C5 + C6): fix migrations 0054 and 0055
- **C5:** either create `settlement_batch_events` (and its dependencies) in a new migration placed before 0054, or drop that subquery from the 0054 view if the view can be flattened to existing relations. Do NOT edit 0054 in place if it has already been applied anywhere — new-fix migration is the safe path (runner applies by filename order; see `db/migrate.ts:87-91` sort).
- **C6:** new migration that first `ALTER TABLE chart_of_accounts ADD COLUMN code TEXT` and corrects the insert shape to `(id, name, kind)` with a legal kind, plus the missing unique index on `code` (or rewrites 0055's contents into the new migration if 0055 never applied successfully anywhere).
- **Verify:** `bun db/migrate.ts` on a **fresh** database completes without 42P01/check violations; `psql` shows the views and the chart rows; existing `go test`/`bun test` unaffected.

### Step 2 (A1): `under_review`-only bulk approve
- `apps/api/src/admin/bulkKyc.ts:27-29` — add `AND onboarding_status = 'under_review'` to the UPDATE (and decide + add the same guard to `kyc_passed` handling).
- Keep the UI checkbox flow (`MerchantListPage.tsx`) — only the server predicate changes.
- **Verify:** new test: bulk-approve a list containing one `under_review` and one `rejected` id → only the former is approved; existing `bulkKyc` tests stay green; `bun test`.

### Step 3 (A4): expose the journaled adjustment
- Decide the surface (owner decision): a dedicated admin route + UI control, or make the existing Adjust-balance route call the journaled variant when finance/super_admin and a flag is set. ADR-0006's distinction is deliberate — display corrections stay cache-only; journaled corrections are for finance-approved real money movements.
- Minimum viable: new route `POST /v1/admin/merchants/:id/balance-adjustments/journaled` gated to finance/super_admin, calling `adjustMerchantBalanceJournaled` (`balanceAdjustments.ts:67`) with the same validation the tested path uses, plus an audit row (the function already records the entry group id on its audit row per `balanceAdjustments.test.ts:217-221`).
- **Verify:** `bun test` (existing journaled tests at :144-253 already cover the function); new route test: finance role 200 + ledger legs + cache move; support role 403; manual curl.

### Step 4 (G11): admin OTP resend
- Add `app.post("/otp/resend", ...)` to `routes/adminAuth.ts` mirroring `routes/auth.ts:199` (merchant version), scoped to the admin session's pending-OTP flow — same OTP-generation transport, admin cookie.
- **Verify:** test asserting resend returns the same pending-session semantics as merchant; `bun test`; manual: admin login → resend → new OTP accepted.

### Step 5 (C2 + C7): make 0073–0077 real (or truth the docs)
- Owner decision gate, like Step 0 of the shadow-ledger plan: CHANGELOG:33 + HANDOVER:53 claim migrations that don't exist. Either (a) implement the intended ones — 0073 callback-dedup unique index is already planned by `webhooks-audit-and-fix-plan-2026-10-30.md` (Step ~Phase A; take two different numbers to avoid collision, e.g. 0074 for BIGINT), or (b) correct CHANGELOG/HANDOVER.
- The only concrete code gap here: `platform_stats.total_processed_fils INTEGER → BIGINT` (migration 0074-equivalent). This is a column-type change: per AGENTS.md and ADR-0001 the money columns are the DBA's province — **stop and get sign-off** before widening; the audit's evidence stands regardless.
- **Verify:** after the widening migration: `\d platform_stats` shows BIGINT; volume-tier tests (`platform_volume_test.go`) still green.

### Step 6 (B1): commit-order consumption (optional priority)
- Replace the id-ordered watermark with an xid8/commit-order watermark in the reporting consumer (`runConsumerPass.ts:44-49`, cursor `0030`), matching the design in HANDOVER ("the xid8 query is in a gist" — obtain/rewrite that query).
- **Verify:** test with two concurrent transactions whose commit order differs from id order — consumer applies in commit order; `bun test` in apps/reporting.

### Step 7 (C8): migration checksums
- Extend `schema_migrations` with a `checksum` column (new migration) and make `db/migrate.ts:47` compute + store a checksum per applied file, refusing to run an applied-and-changed migration (diff on the stored vs current checksum).
- **Verify:** migrate twice — unchanged tree applies nothing; edit an applied `.sql` → next migrate refuses with a checksum error; fresh DB applies cleanly.

### Step 8 (E3): SEED_SIZE=full
- Implement the `full` path: pass the size into `db/seed/generate.ts` and generate the larger/denser fixture dataset (or explicitly reject `full` with a clear message until it is implemented — the current silent same-data behavior is the bug).
- **Verify:** `SEED_SIZE=full bun db/seed/index.ts` produces measurably more rows than small (count assertions on merchants/transactions); `SEED_SIZE=small` unchanged.

### Step 9 (F2): add the demo hurl script
- Create `scripts/demo/admin-login.hurl` per the docs' promise (`docs/README.md:143`): admin login + OTP verify against the running stack (mirror `docs/README.md` demo instructions), exactly one command as documented.
- **Verify:** `hurl scripts/demo/admin-login.hurl` (against a booted dev stack) exits 0 and logs in; the file matches what docs/README describes.

---

## 4. Scope

### In scope
- The nine steps above in the named files (bulkKyc.ts, balanceAdjustments + route, adminAuth.ts, migrations 0054/0055 fixes + new 00xx, seed/index.ts + generate.ts, db/migrate.ts, scripts/demo/admin-login.hurl).

### Out of scope / owned by siblings or frozen
- Bulk-approve UI/UX polish → `webapp-ui-ux-improvements-2026-10-30.md`.
- Callback-dedup migration 0073 → `webhooks-audit-and-fix-plan-2026-10-30.md` (coordinate numbers).
- Refund/webhook API work → `payment-gateway-evaluation-2026-10-30.md`, `webhooks-audit-and-fix-plan-2026-10-30.md`.
- `packages/money/`, `apps/settlement/internal/money/`: frozen. Test files: regression-locked.
- Migration 0054 view `merchant_payable_position`'s gross-value semantics → `settlement-money-correctness-plan-2026-10-30.md` (S6).

### Verification commands (whole plan)
```
bun db/migrate.ts                          # fresh DB: clean apply, no 42P01/CHECK
bun test                                   # repo root
cd apps/settlement && go test ./...
hurl scripts/demo/admin-login.hurl         # after Step 9 + booted stack
psql "$DATABASE_URL" -c '\d platform_stats'   # after Step 5: BIGINT
```

---

## 5. Risks

- **C5/C6 block every fresh environment** — fix first; a migration that already applied anywhere must never be edited in place (new-fix migration instead).
- **A1** changes admin behavior — the current force-approve is a real data-integrity bug (approves rejected merchants); the fix is small but the regression test must pin the rejected-id case.
- **A4 + C7** are owner decision points (surface choice; column-type change needs DBA/finance sign-off per ADR-0001 + AGENTS.md) — implement the code paths, but do not widen columns or pick the UI without the orchestrator's call.
- **B1/C8** touch the outbox and the migration runner — both are cross-cutting; the checksum change affects every future migration run, so the checksum algorithm must be decided once (content hash of the file) and documented in the runner.
- Sibling agents share `apps/api/src`, `db/migrations/`, `db/seed/` — coordinate file-level write ownership before merging.

---

*Evidence artifacts: this plan's claims were verified in `waves/fp-gap-audit-collect/collect-admin.md`, `collect-ops-db.md`, `collect-api.md` and `waves/fp-gap-verify/verify-admin.md`, `verify-ops-db.md`, `verify-api.md` (run tmp root of the audit lane), each row carrying the rerun command and its verbatim output.*
