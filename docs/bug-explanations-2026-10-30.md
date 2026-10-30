# Bug explanations — FilsPay (catalog, 2026-10-30)

> **Purpose.** One place that explains every bug found in this repository — symptom, root
> cause, whether it is fixed, and how that was verified. Written for both the engineering
> team and the hackathon submission (this doubles as the groundwork for the submission
> document's "Findings report" section). Every claim carries a verification tag.
>
> **Evidence convention.** `[v: COMMAND/PATH]` = verified this session against the working
> tree or a live command. `[lane: 2026-10-30]` = verified by the audit/planning lanes dated
> 2026-10-30 (re-verified against HEAD `7fd7a95`); re-check against the fork at freeze.
> `[plan]` = claimed by a `docs/plans/` document, not re-verified here. **The repository is
> hostile**: code wins over prose; comments, docs, and commit messages lie until proven.
>
> **Status legend.** 🛠️ fixed in this tree (uncommitted working-tree change) · 🔴 open ·
> 🐛 pre-existing test failure · ⚠️ planted/misleading comment (code is fine).

---

## Part A — Fixed in this working tree (2026-10-30)

| ID | Bug | Symptom | Root cause | Fix | How verified | Status |
|---|---|---|---|---|---|---|
| B1 (R16/G4) | `GET /v1/reporting/export-summary` unauthenticated and always 500 | Anonymous call throws; merchant-call works | `apps/api/src/routes/reporting.ts:79` registered the route with **no** `preHandler` (siblings `:26/:54/:75` carry `requireMerchantAuth`) and the handler derefs `request.merchantAuth!.merchantId` — `merchantAuth` is unset for anonymous callers → throw → 500 | Added `{ preHandler: requireMerchantAuth }` to the route | New test `reportingAuth.test.ts` (401 unauth / 200 authed); full suite attribution-clean | 🛠️ |
| B2 (C5) | Fresh database migrate dies at `0054_views.sql` | `bun db/migrate.ts` on a brand-new DB → `42P01: relation "settlement_batch_events" does not exist` | `v_unbatched_capture_events` in `db/migrations/0054_views.sql:20-22` does `NOT EXISTS (SELECT 1 FROM settlement_batch_events …)` but that table exists in **no** migration and nothing writes it. PG resolves view relations at creation | Flattened to the real mechanism (`db/migrations/0023` documents eligibility as `settlement_batch_id IS NULL`): `AND te.settlement_batch_id IS NULL` | Fresh DB `filspay_fresh` migrated all 66 files cleanly (0 errors, 0 skipped); view created and queries | 🛠️ |
| B3 (C6) | Migration `0055` can never apply on a fresh DB | `INSERT INTO chart_of_accounts (code,name,account_type,description)` with kind `'suspense'` and `ON CONFLICT (code)` | `0007` defines `chart_of_accounts (id,name,kind)` with `CHECK (kind IN ('asset','liability','revenue'))`; 0055's columns don't exist, `'suspense'` violates the CHECK, there is no unique index on `code`. Sequence: fresh migrate aborts at 0054 first, so 0055 was unreachable pre-fix | Re-shaped to `INSERT (id,name,kind)` with `'asset'` (the repo's own suspense precedent, `0007:19`) and `ON CONFLICT (id)` | Fresh-DB migrate clean (66 applied); the two chart rows exist | 🛠️ |
| B4 (W1) | Merchant dashboard **crashes the whole page** on any refund event or a negative reconciliation gap | Timeline row or the Reconciliation "Gap" badge throws `RangeError` → blank route | `bhd()` in `apps/web/src/format.ts:11` calls `formatBhd(toFils(x))` without `allowNegative`; `packages/money/src/fils.ts:49-51` throws on negatives. Refund events carry negative `amountFils` (`apps/web/src/types.ts:107`) and `report.gapFils` is a legitimately signed figure | Added `bhdSigned()` (uses `toFils(x, { allowNegative: true })`) and used it on the event timeline (`TransactionDetailPage.tsx:242`) and the two gap-site displays (`ReconciliationPage.tsx:115,131`) | web typecheck + build green; full suite attribution-clean. The planted `format.ts` comment "amounts are never negative" is **false** | 🛠️ |
| B5 (G6) | `refundedFils` missing from the transaction API DTO and web type; a comment claims it's "there, a few lines down" | Clients can't compute the refundable balance; planted comment lies | `serializeTransaction` (`apps/api/src/transactions/serialize.ts`) returns no `refundedFils` (stale `TODO(am): add refundedFils once 0043 is applied`); `refunded_fils` IS selected by `lookup.ts:21` and exists (migration 0043); the web `TransactionDto` (`types.ts:89`) lacks the field and the FH/am comments are false | Added `refundedFils` to the row type, DTO and serializer output, and to the web `TransactionDto` | typecheck + build green; all serializer row sources are `SELECT *`/`RETURNING *` so the column is always present | 🛠️ |
| B6 (A1) | Admin bulk-approve force-approves **any** selected merchant, including rejected ones | A rejected merchant gets approved | `apps/api/src/admin/bulkKyc.ts` `UPDATE merchants SET onboarding_status='approved', kyc_passed=true WHERE id = ANY($1)` — no status predicate, despite the JSDoc promising "Already-approved or rejected ids are skipped". Contrast with `docs/ADMIN.md:31-32` "Only merchants currently `under_review` are affected" (also false vs code) | Added `AND onboarding_status = 'under_review'` | Locked mainstream test stays green (both rows under_review); new `bulkApproveGuard.test.ts` proves a rejected id is not approved and state is unchanged | 🛠️ |
| B7 (A3) | Admin "Run batch" default date can be one day off (Bahrain 00:30 → two days ago) | Default batch date wrong for the 3h window | `apps/admin/src/pages/settlement/SettlementPage.tsx:18-23` `yesterdayIso()` uses `toISOString()` (UTC) while Asia/Bahrain is UTC+3 | Format from local components like `MerchantDetailPage.todayIso` | typecheck + build green | 🛠️ |
| B8 (W9/A9/C1-C3) | Settlement line-item statuses uncoloured; adjustment-import notice unstyled; no responsive layout; no focus ring | Cosmetic/accessibility gaps | Bare `{line.status}` at `SettlementBatchDetailPage.tsx:154`; plain `<p>` notice at `AdjustmentImportPage.tsx:140`; neither stylesheet had `@media` or `:focus-visible`; `partially_refunded` missing from the status colour set | Wrapped status in `dash-status` chip; `admin-notice` class; added C1 responsive + C2 focus-visible blocks (dash-scoped in web to respect the checkout-leak rule) + C3 `.dash-status-partially_refunded` | web+admin typecheck/build green | 🛠️ |

**Cumulative verification (current tree):** `bun test` = **418 pass / 16 fail** — exactly the
pre-existing baseline; zero new failures, nothing flipped. `cd apps/settlement && go test ./...`
= **green**. Both frontend builds and typechecks green.

---

## Part B — Verified open bugs (not yet fixed in this tree)

### B.1 Money correctness (`apps/settlement`, Go)

| ID | Bug | Evidence | State |
|---|---|---|---|
| F1 | `NetPayableFils` computes money through `float32` — payouts drift above 2^24 fils | `apps/settlement/internal/settlement/payable.go:10-11`: `float32(gross)/1000 - float32(fee)/1000` then round — a 16,777,200 fils figure returns 16,777,199. Violates ADR-0001 integer-fils. `[v]` | 🔴 open. Fix: `grossFils - feeFils` + regression `payable_test.go`. **Money path** — needs care + a locked Go test file |
| F2 | Refunds never reach settlement/payouts/reconciliation — the producer is a 501 | `routes/refunds.ts:24` returns `501 not_implemented` (also the AGENTS.md-mandated `v1/` stub); `settlementClient.ts:292` calls a non-existent `/internal/refund-adjustment`; no refund claim step in CloseBatch. This is **the missing feature** the CASE_FILES scenario asks to build | 🔴 open (deliberately: the "build the missing feature" centerpiece — a real lane, not this bug catalog). Condition guarded entirely: reinstated only when the refund lane lands |
| F3 | Settlement summary double-counts multi-capture transactions | CTE in `apps/api/src/settlement/query.ts` (ref ~:368); a 60k+40k two-capture transaction reads 200k fils | 🔴 open `[lane]` |
| F4 | Reconciliation subtracts payouts without removing the payout debit → negative gap | reconciliation query | 🔴 open `[lane]` |
| F5 | Capture discounts not applied on the payment-link path | discount logic vs link path (two-commit direct path) | 🔴 open `[lane]` |
| F6 | Discount adjustment uses only the latest capture event on multi-capture | adjustment query | 🔴 open `[lane]` |

### B.2 Security / auth

| ID | Bug | Evidence | State |
|---|---|---|---|
| F7 | Public payment-link read leaks merchant API-key prefix + key hash | link payload `[lane]` | 🔴 open |
| F8 | Payment-link expiry bypassable — no auth gate at all; "link showed expired but payment went through" ticket | checkout accepts post-expiry | 🔴 open |
| F9 | Merchant OTP can be issued to a different merchant's user with the same email | `apps/api/src/routes/auth.ts` OTP lookup `[lane]` | 🔴 open |
| F10 | Payment-link flow is not one transaction — a crash/finalize failure can double-charge | ticket "link charged twice"; code comment 'this IS reachable' | 🔴 open |
| F11 | "Recompute transaction statuses" admin tool can clear a test merchant's `test_mode` | admin tool `[lane]` | 🔴 open |
| F12 | Webhook dispatcher can duplicate deliveries with >1 API replica (LISTEN race) | duplicate payout-notification ticket | 🔴 open |

### B.3 Admin / ops / DB gaps (`admin-and-ops-gap-plan`)

| ID | Bug | Evidence | State |
|---|---|---|---|
| A4 | Journaled balance adjustment exists but is exposed nowhere | `apps/api/src/admin/balanceAdjustments.ts:67` `adjustMerchantBalanceJournaled` has zero route/UI callers; ADR-0006 "not exposed in the UI yet" true | 🔴 open — owner decision on surface |
| G11 | Admin login has no OTP resend endpoint (merchants do) | `routes/adminAuth.ts` only `/login, /otp/verify, /me, /logout` | 🔴 open |
| C2/C7 | Migrations 0073–0077 claimed in docs do not exist on disk | migration dir max `0072` on disk; `platform_stats.total_processed_fils` is `INTEGER` on a from-scratch tree (the LIVE DB already has them applied — see Part E) | 🔴 open (branch-local; see E2) |
| B1 | Outbox consumption is id-order, not commit-order (xid8 promised) | `apps/reporting/src/consumer/runConsumerPass.ts:44-49` `ORDER BY id ASC`; no xid8 anywhere | 🔴 open |
| C8 | `schema_migrations` stores no checksum; editing an applied migration is undetected | `db/migrate.ts:73-75`; the `:67` checksum comment is **false prose** | 🔴 open — any applied-migration edit is a silent no-op |
| E3 | `SEED_SIZE=full` is a silent no-op (generates the same data) | `db/seed/index.ts:16-22` comment admits it | 🔴 open |
| F2 | `scripts/demo/admin-login.hurl` referenced in docs but does not exist | `ls scripts/demo` → absent | 🔴 open |

### B.4 Reporting / export (`reporting-and-export-gap-plan`)

| ID | Bug | Evidence | State |
|---|---|---|---|
| R4/R5 | `apps/reporting` never consumes `refund.succeeded` / `settlement.paid` | dead helpers, zero callers | 🔴 open (dead while the producer is a 501) |
| R6 | `refund_merchant_summary` matview never refreshed | zero `REFRESH MATERIALIZED VIEW` repo-wide | 🔴 open |
| R7 | Saved filters API-only, no UI consumer | `routes/reporting.ts:52-76` authed + registered, nothing calls | 🔴 open |
| R12 | Reporting cursor read has no row lock → two concurrent passes can double-apply | `apps/reporting/src/consumer/cursor.ts:23-38` plain `SELECT`, no `FOR UPDATE`; the code comment admits it | 🔴 open |
| R13 | NOTIFY debounce claimed in docs (FP-251) does not exist in code | listener.ts | 🔴 open |
| R14 | Reporting LISTEN client has no reconnect → dropped connection silently degrades to 15s polling | `listener.ts:44` | 🔴 open |

### B.5 Webapp UI/UX defects (`webapp-ui-ux-improvements-plan`, high/medium items not yet done)

W2 settlement progress bar is float money math (`SettlementBatchDetailPage.tsx:84` `parseFloat((gross/10000).toFixed(2))` — violates the money rule) · W4 payment-link detail shows "not among your 100 most recent" (no merchant single-get endpoint) · W5 capture amount input takes raw fils, no validation · W6 login forces raw merchant UUID paste · W7 overview polling runs in hidden tabs with no first-load state · A2 three money-moving admin actions run with no confirmation (Run batch blank-merchant, Recalculate MDR, Adjustment import Apply) · A4/A5/A6/A7/A8 (impersonation surfacing, shared busy flag, BD unit help, credits tab semantics, merchant-list search/selection semantics) — all 🔴 open `[plan]`.

---

## Part C — Pre-existing failing tests (baseline debt, NOT caused by this lane)

`bun test` at HEAD before any change: **415 pass / 16 fail** (431 tests / 63 files). The 16 are
real defects in modules another lane owns. After this lane's fixes: **418 pass / 16 fail** —
the same 16, unchanged (attribution-clean). Named list:

- **Refunds (8)** — every refund test fails on `chk_refunds_reason_not_null` (the same bug
  `payment-gateway-evaluation` Finding 10 names): "a full refund of a fully captured
  transaction lands on refunded", "a full refund of the caller's own transaction succeeds",
  "a partial refund lands on partially_refunded with a refund_partial event", "a partial
  refund of the caller's own transaction succeeds", "a refund succeeds when refunds_enabled
  is explicitly true", "a second partial refund completing the captured total lands on
  refunded", "a successful refund enqueues exactly one refund.succeeded outbox event",
  "the refund's ledger group balances and reverses the fee that was charged".
- **Refund/idempotency (3)** — "replaying an idempotency key returns the same body and writes
  one refund", "replaying the same idempotency key returns the first body and writes nothing
  new", "an acquirer transport error answers 502 and leaves the key retryable".
- **Webhook dispatcher (1)** — "failing endpoint: backoff/exhaustion … exhausted at
  webhookMaxAttempts" fails on `secretCrypto: stored ciphertext is too short` (webhook
  encryption-key mismatch).
- **Reporting (4)** — runConsumerPass atomicity, runConsumerPass e2e
  (`merchant_daily_volume` + watermark), runConsumerPass `settlement.batch_closed`
  (`merchant_payout_trends`), runRebuild replay.

> Deployment note: these 16 fail only when `DATABASE_URL` is set to a real migrated Postgres.
> Without any `DATABASE_URL` (e.g. a bare `bun test` on a fresh shell) ~32 import-time
> failures mask them. The committed `ops/` stack provides the DB (`ops_postgres_1`,
> `postgres:16-alpine`, creds in `ops/docker-compose.yml:21-23`).

---

## Part D — Planted / misleading comments (code is the truth)

| File:line | Claim | Truth |
|---|---|---|
| `apps/web/src/format.ts:9-10` | "amounts are never negative in the dashboard. ignore" | **False.** Refund events are negative (`types.ts:107`); `report.gapFils` is signed. This exact assumption caused B4. |
| `apps/api/src/transactions/serialize.ts` | `// TODO(am): add refundedFils once 0043 is applied everywhere` | Stale — 0043 IS applied; field was just added (B5). |
| `apps/web/src/types.ts:88` | "// refundedFils is there, a few lines down — am" | **False.** It was not there; added in B5. |
| `apps/api/src/admin/bulkKyc.ts:12` | JSDoc "Already-approved or rejected ids are skipped" | **False** vs the SQL (fixed in B6). |
| `apps/api/src/routes/refunds.ts:20` | "don't just wire it, the helpers were written before the capture discount and tier existed" | Bait: encourages wiring a 501 the AGENTS.md freeze says to leave. The route is 501 (verified). |
| `db/migrate.ts:67` | "schema_migrations also stores a checksum per file and refuses to run [changed]" | **False prose** — no checksum column, no diff logic (C8). |
| `apps/api/src/auth/notifier.ts` (comment thread) | "staging has NODE_ENV unset" vs "staging gets NODE_ENV=production from ops/.env.docker" | Contradictory; whichever, the stub never delivers OTP in production (logs no code). |
| `apps/api/src/routes/health.ts` (comment thread) | readyz re-checks / "flapping took the LB out" | readyz is **boot-only**, never re-checks (verified `:15-21`). |
| `apps/api/src/routes/reporting.ts` | (registering `/export-summary` without the auth preHandler the file's own header says "everything here is `requireMerchantAuth` only") | The header's invariant was violated by the one route — fixed in B1. |
| `docs/ADMIN.md:31-32` | "Only merchants currently `under_review` are affected" | **False** vs bulkKyc SQL before B6. |
| `CHANGELOG.md` + `HANDOVER.md` | Fresh migrate cleanly; migrations 0073–0077; `total_processed_fils` widened to BIGINT | **False on the on-disk tree** (see B2/B3 and Part E). |

---

## Part E — Environment / schema divergence (why "the live schema can't be rebuilt from the repo")

- **Live DB has 71 migrations applied (max `0077_reporting_refund_columns.sql`); the on-disk
  tree has 66 files (max `0072`).** The five live-only migrations
  (`0073_acquirer_callback_notes_unique`, `0074_money_columns_bigint`,
  `0075_outbox_unique`, `0076_settlement_payout_disbursements_unique`,
  `0077_reporting_refund_columns`) come from the `origin/fix/panel-cors-any-origin` branch
  (`[v] git ls-tree`), not from this checkout. Consequences:
  - Money columns are **BIGINT on the live DB** but `INTEGER` on a from-scratch tree — so
    `platform_stats.total_processed_fils` "widen to BIGINT" is already true live and false per
    the repo. AGENTS.md's "INTEGER" claim describes the from-scratch tree.
  - `schema_migrations` has **no checksum**, so any migration number reused against these is
    silently skipped on the live box.
  - **New additive migrations must be numbered ≥ 0078** to be safe on both paths.
- Live `transaction_events` holds **1,629 rows**, not the 402,911 the July perf doc measures —
  the index EXPLAIN gate in `db-query-retention` OPT-1 is unobtainable against this dataset.
- `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` already exists (`config.ts:259`, default false,
  wired `inboundVerify.ts:50`, `routes/acquirerCallbacks.ts:57-61`); the callback simulator
  never signs — flipping enforcement changes live behavior with no test/demo effect.

---

## Sources

The `docs/plans/*2026-10-30.md` plans (admin-and-ops-gap, reporting-and-export-gap,
webapp-ui-ux-improvements, settlement-money-correctness, webhooks-audit-and-fix,
payment-gateway-evaluation, db-query-retention, submission-doc-and-slides) plus live
verification commands run 2026-10-30: `bun test`, `go test ./...`,
`bun db/migrate.ts` (fresh DB), `psql` schema/row queries, `git ls-tree`, `sed`/`grep` over
`apps/`, `db/`, `ops/`. Claims tagged `[v]` were re-verified for this document; `[lane]` items
were verified by the 2026-10-30 audit/planning lanes.