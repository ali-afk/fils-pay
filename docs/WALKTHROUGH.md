# FilsPay — the full walkthrough (read this to own the code)

A step-by-step tour of the entire repository with context. Written for the
handover repo at its pristine base (`8b58b0f`) — the code as the hackathon
handed it over, with every planted weakness still present. The companion
knowledge base (`docs/README.md` guide, `docs/bugs/` open ledger,
`docs/EXPLANATIONS.md` fixed-work detail, `CHANGELOG.md` register) explains
what is wrong and what was once fixed. Read order suggestion is at the bottom.

---

## Step 0 — Orientation

- `packages/money/` — the integer-fils toolbox. Read first; everything hangs
  off it.
- `packages/events/` — outbox event types (the reliable notification bus).
- `apps/api/` — TypeScript + Fastify: the HTTP front desk (auth, payments,
  payment links, webhooks, admin console API).
- `apps/settlement/` — Go daemon, the accountant: daily close, fees, payouts,
  scheme export, balance cache, internal HTTP API on `:8091`.
- `apps/reporting/` — TypeScript worker: reads the outbox, keeps dashboards fast.
- `apps/web/` — React/Vite: hosted checkout + merchant dashboard.
- `apps/admin/` — React/Vite: ops console (support / finance / super_admin).
- `db/migrations/` — Postgres schema, numbered 0001–0072 in the pristine repo.
- `scripts/` — one-off ops (March reconcile, expire holds).
- `ops/` — compose + env. NOTE: Dockerfiles are missing in the pristine repo
  (open finding B24).

**Architectural key:** the database is the bus. Services share one Postgres
and exchange work through a transactional outbox plus `LISTEN/NOTIFY`
wake-ups; the one HTTP exception is admin → settlement's internal API.

## Step 1 — The money model (the part to nail first)

- `1 BD = 1000 fils` (three minor units). ADR-0001: integer fils everywhere —
  `BIGINT` columns ending `_fils`, no floats, no `parseFloat` on money.
- `packages/money/src/fils.ts`: `parseBhdToFils("4.75") → 4750`,
  `applyRateFils(amount, bps)` (one rounding, half-to-even — the single fee
  primitive), `bankersRoundDiv`, `allocateRemainder` (exact splits),
  `calculateRefundFee`, `formatBhd`.
- The ledger is double-entry: `ledger_entries` has ≥2 legs per
  `entry_group_id`, and a deferred constraint (migration 0007) refuses any
  group whose debits ≠ credits. Balance is *enforced*, not hoped.
- Accounts: `merchant_payable` (what we owe merchants), `platform_fee_revenue`
  (our cut), `card_scheme_clearing` (money at the network), `platform_cash`,
  suspense accounts.
- `merchant_balances.cached_payable_fils` is a cache rolled up from the ledger
  (its wrong-source sibling is open finding M-7).

## Step 2 — One payment, end to end

1. **Bootstrap:** `bun run migrate` applies 0001–0072 idempotently;
   `bun run seed` loads deterministic demo data + runs ledger self-checks.
2. **Merchant signup:** `POST /v1/onboarding` → business profile + KYC docs →
   admin review → `kycPassed=true` (filename-based PDF check = open S-1).
3. **Login:** password (argon2id) → OTP → pending session promoted to cookie
   `fp_sid` (OTP weaknesses: open H-6..H-10).
4. **Authorize:** `POST /v1/transactions` → acquirer simulator validates the
   card → `hold` row reserves funds (a reservation, not a charge).
5. **Capture:** `POST /v1/transactions/:id/capture` — the heart:
   - `SELECT … FOR UPDATE` locks the row and is held across the acquirer call
     (serializes concurrent captures);
   - fee = `applyRateFils(captured, mdr − volumeTier)` (payment-link path
     misses the discount = open C-5);
   - posts one balanced ledger group (clearing credit; fee revenue + merchant
     payable);
   - sets `captured_fils`/status and enqueues `transaction.captured` in the
     **same transaction** (outbox).
6. **Settlement (Go, nightly):** `CloseBatch` per merchant/day picks up
   unbatched captures, recomputes fees (a second fee path — C-5/M-8), truncates
   scheme lines to a multiple of 10 fils; `PayoutBatch` flips the batch to
   paid, posts payout legs, enqueues `settlement.paid`. (Pristine gaps:
   residue not posted, `settlement.paid` never emitted, net payout float32 =
   C-1.)
7. **Webhook:** the outbox row is dispatched: Step A creates
   `webhook_deliveries`, Step B signs (`t=...v1=...` HMAC over a re-serialized
   object — B11/H-13) and POSTs to the merchant's URL.
8. **Refund:** in the pristine repo `POST /v1/refunds` is a **501 stub** — the
   unfinished feature. The helpers exist (`payments/processRefund.ts`) with
   latent issues (ceiling from authorized not captured; no row lock → FP-209;
   reason NULL vs DB check → abort after money moves; nothing feeds back into
   settlement/payouts/reconciliation = open C-2).

## Step 3 — Payment links (the second money path)

`create` (owner) → link with a token; `pay` on a **public** route whose expiry
check trusts a client-sent `submittedAt` (open H-3/P-1/B14/B15); `status` /
`cancel` (merchant-scoped); checkout at `/pay/:token`. Single-use enforced by
`CHECK ((status='paid') = (transaction_id IS NOT NULL))`.

## Step 4 — Webhook/outbox machinery

Money-affecting writes enqueue `outbox_events` in the same transaction; the
dispatcher (api) and the reporting consumer (reporting) each read it with
their own cursors. The dispatcher has a poll fallback so a missed NOTIFY can't
strand a delivery; deliveries get exponential backoff and a stable
`delivery_event_id`. (Pristine gaps: R-3 duplicates across replicas; R-4 no
key rotation; H-12/H-13 acquirer callbacks unsigned/re-serialized.)

## Step 5 — Admin plane

Separate cookie `fp_admin_sid`, separate tables, roles
`support < finance < super_admin` enforced per route. `admin/*` modules:
credits (+second approver above a threshold), balance adjustments
(cache-only, ADR-0006), impersonation ("view as merchant" — role-escalation
issue H-4), merchants, bulk KYC, reporting rebuilds, adjustment CSV imports
(the BD-parse 10x bug = B1). The audit's H-1..H-5, M-1..M-12, S-* live here.

## Step 6 — Reporting

`apps/reporting` consumes outbox events into `merchant_daily_volume` /
`merchant_payout_trends`. Pristine gaps: no refund or `settlement.paid`
handling (F-2/L-3), UTC bucketing, the refund summary matview joins the wrong
column (M-12/0072).

## Step 7 — Frontends

- `apps/web`: checkout (`/pay/:token`, public, cookie-free) + dashboard under
  `/dashboard/*` guarded by `RequireDashboardAuth`; money rendered via
  `formatBhd`; API base `VITE_API_BASE_URL` (default `localhost:3000`) with
  `credentials: include`.
- `apps/admin`: console with `VITE_ADMIN_API_BASE_URL`; "view as merchant"
  uses `VITE_WEB_BASE_URL` for the impersonation link.

## Step 8 — Ops / running it

- `bun run migrate` → schema; `bun run seed` → demo data (deterministic;
  self-checks include "every ledger group balances").
- Compose (`ops/`): postgres + migrate + seed + api + settlement + reporting.
  In the pristine repo compose is partly a promise — Dockerfiles + token/env
  wiring were fixed in the stashed work (B24).
- Tests: `bun test` and `go test ./...` in `apps/settlement`.

## Step 9 — The bug landscape (knowledge base, front-loaded)

- **60 open findings** in `docs/bugs/` — read first: **C-1** (net payout
  float32 ⇒ payouts drift past 2^24 fils), **C-2** (refunds never reach
  settlement/payouts/reconciliation; the admin route called doesn't exist),
  **C-3/C-4** (summary/reconciliation double-counting), **H-1/H-3/H-4/H-6/H-10**
  (credential/authorization boundaries), **C-5/C-6/M-8/M-9** (divergent fee
  formulas).
- **Fixed-work** detail: `docs/EXPLANATIONS.md`; register: `CHANGELOG.md`.
- The three-transmissions mystery + flag: `docs/README.md` and
  `docs/EXPLANATIONS.md` §M2.

---

## Suggested reading order

1. `docs/README.md` (~30 min) — the guide.
2. This walkthrough's Step 2–Step 3 with `apps/api/src/payments/capture.ts`,
   `authorize.ts`, `processRefund.ts` open (~1 hr).
3. `packages/money/src/fils.ts` + its tests (~30 min).
4. Go settlement: `apps/settlement/internal/settlement/batch.go` (~1 hr).
5. `docs/bugs/C-1.md`, `C-2.md`, `H-3.md`, `H-6.md` — see the audit's style.
6. `docs/EXPLANATIONS.md` — the history of what was found and fixed.
