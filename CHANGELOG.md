# Changelog

All notable changes to FilsPay. Dates are deploy dates (Asia/Bahrain).
Versions are the API image tag; settlement and reporting are versioned with
it. Format loosely follows Keep a Changelog.

## [Unreleased] - 2026-10-30

The Handover audit round: every change since the handover tip `8b58b0f`
(re-authored under the corrected identity). Registries: open findings in
docs/bugs/ (one file per finding); fixed-work detail in docs/EXPLANATIONS.md.

### Toolchain

- **npm → bun**: `bun install` (bun.lock canonical; package-lock.json dropped).
  migrate/seed run as `bun db/migrate.ts` / `bun db/seed/index.ts`, tests as
  `bun test`, workspace tasks via `bun run --filter '*'`, compose commands exec
  `bun`, script shebangs are `#!/usr/bin/env -S bun`. No npm needed.

### Added
- **Refunds feature, end to end** (`5fe1d4a`, `f8846e8`): `POST /v1/refunds`
  wired to the locked `processRefund` (captured-based ceiling, single
  transaction + `FOR UPDATE` across the acquirer call, net-of-discount fee
  reversal, reason defaulting); `refund.succeeded` webhook (envelope case +
  eligibility) ; reporting refund rollups + matview refresh (`a82656d`);
  merchant web RefundDrawer (`327e5ea`).
- Webhook hardening: sign the exact bytes sent (`e0ddf3b`); dispatcher LISTEN
  reconnect on channel drops (`a808bf7`); payout-disbursement dedup.
- Demo tooling: `scripts/demo/admin-login.hurl` (`c8d6d97`).

### Fixed
- Fresh database migrates cleanly (0054 view, 0055 chart inserts; `0b7e9f4`),
  migrations 0073–0077 added.
- Money/ledger: settlement splits exact (largest-remainder), scheme residue
  posted at close, MDR recalc closed-only, BIGINT counters, balance button
  uses the ledger rollup (`3ce9fa1`); CSV import parses BD correctly (`5d94b0b`);
  fee display resolves the effective rate; payout estimate + volume counters
  fixed.
- Payments: refund ceiling + FP-209 concurrency (`f8846e8`); capture
  idempotency hash includes the transaction (`5d94b0b`); payment links:
  merchant-scoped cancel, server-clock expiry gate, no phantom 200 on a lost
  finalize (`165a6d4`).
- Reporting: consumes `refund.succeeded` and `settlement.paid`, scoped child
  reports, one rebuild path, authed export-summary (`a82656d`).
- Web: dashboard CORS at runtime + root redirect (`33f0201`).
- Seed: alpha booked at the effective fee rate, test-mode merchants isolated,
  poison `production_seed.sql` removed (`7298d50`).

### Security
- Merchant login requires OTP: pending sessions authenticate nothing
  (`0446569`).
- Acquirer callback notes deduped per `(transaction_id, callback_id)`;
  outcome/occurredAt validated; shipped env requires callback signatures
  (`0446569`).
- Admin gates: credit creation requires finance/super_admin; impersonation
  is read-only support (`1505ffa`).

### Changed
- Ops: Dockerfiles added + compose token/env wiring (`fbddb5c`, `f2df131`);
  README migrate-wait hardening.
- Docs: consolidated guide (`docs/README.md`), per-bug ledger
  (`docs/bugs/`), tutorial (`docs/TEACHING.md` removed into the guide),
  corrected lore (AGENTS.md money/token claims), incidents 2026-10-30.

## [1.9.2] - 2026-09-12

### Changed
- Volume-tier threshold updated for the platform-wide discount (d69a813).
  No pricing change for existing merchants.
- Dependency bumps across the workspace.

### Fixed
- Config: settlement now reads `DATABASE_URL` consistently with the other
  services (b64cd3c).

## [1.9.1] - 2026-08-22

### Fixed
- Duplicate `settlement.paid` webhooks (incident 2026-08-21). Receivers
  should dedupe on `Webhook-Delivery-Id`.
- Reporting worker no longer holds an extra LISTEN connection after a
  reconnect (#398).

## [1.9.0] - 2026-07-21

### Added
- Acquirer callback notes (`acquirer_callback_notes`, migration 0051) and
  signed callback verification (`inboundVerify`).
- Reporting saved filters (migration 0069).

### Security
- Inbound acquirer callbacks are now signature-checked and deduplicated.

## [1.8.0] - 2026-06-24

### Added
- Transactions CSV export (`GET /v1/transactions/export`). Streams rows, so
  it is safe for large merchants on the 512 MB container.
- KYC document thumbnails.
- Webhook delivery archive and replay for support.

## [1.7.1] - 2026-06-09

### Added
- Admin: **Import adjustments** from finance's CSV sheets (BD amounts).
- Partial-batch payout corrections in settlement (76913d3).

### Fixed
- Net payout figure now derived once per batch, so the bank instruction,
  statement and report agree.

## [1.7.0] - 2026-06-03

### Added
- Admin: **Rebuild cached balances** (finance and above). Same rebuild as the
  `settlement rebuild-balances` CLI, exposed through the internal API.
- Admin: **Recalculate MDR** for a merchant and date range.
- Payout disbursement records (migration 0057).

## [1.6.0] - 2026-05-20

### Added
- Admin credits with second-approver workflow above the threshold.
- Admin: **Rebuild analytics**.
- Platform volume tier.

### Fixed
- Incident 2026-05-14: payment links could be captured more than once when
  the acquirer re-sent a callback. Callbacks are now deduplicated on
  `callbackId`.

## [1.5.0] - 2026-05-07

### Added
- Admin: bulk KYC approve.
- Admin: Adjust balance (support).

### Changed
- README money section rewritten for new hires.

## [1.4.0] - 2026-04-28

### Added
- `transactions.refunded_fils` (migration 0043) in preparation for refunds.
- Refunds: `processRefund`, `refundValidation`, `refundState` helpers and the
  dashboard `RefundDrawer` (behind a flag).

## [1.3.2] - 2026-04-09

### Fixed
- README typo.

## [1.3.1] - 2026-03-19

### Added
- Negotiated merchant discount (`negotiated_discount_bps`, migration 0047),
  applied after MDR at capture and settlement.
- Split settlement for marketplaces.

### Fixed
- March reconciliation: scheme rounding residue swept to suspense (one-off,
  `scripts/reconcile_march.ts`). March ties out.

## [1.3.0] - 2026-03-10

### Added
- Third-decimal scheme amount on export lines (`amount_3dp`, migration 0038)
  so the residue can be posted per line.

### Removed
- `amount_3dp` reverted the same week; migration number reused for KYC
  thumbnails.

## [1.2.1] - 2026-02-24

### Fixed
- Settlement report totals (hotfix).

## [1.2.0] - 2026-02-23

### Added
- Lifetime payout estimate for monitoring (migration 0040).

## [1.1.0] - 2026-01-18

### Added
- Payment links.
- Webhooks with HMAC signatures and replay.

## [1.0.0] - 2025-12-14

First production release: merchant onboarding with KYC, card capture and
void, daily settlement in Asia/Bahrain business days, scheme file export
with residue journaled at export, reporting read model.
