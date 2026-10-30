# FilsPay bug ledger — index

Every confirmed finding in the current checkout, one file per bug. Extracted
verbatim from the 2026-10-30 audit (`docs/archive/audit-bugs-2026-10-30.md` —
an audit of the whole repository: a finding is listed **only** where the code
does the wrong thing; demonstrably-fixed work lives in **Fixed work** below).

**60 open findings: 6 critical money (C), 13 security (H), 4 payment-link (P),
12 money-path (M), 7 reliability (R), 9 validation (S), 8 operational (L),
1 reporting (F-2).** Status per file is `Open` unless marked `latent` (dead or
unwired path). Suggested fix order is in the audit (§10) and mirrored below.

## The money-critical ones first

| Id | Bug | Why it matters |
|---|---|---|
| [C-1](C-1.md) | `NetPayableFils` still float32 | every payout over 2^24 fils drifts — the ledger, statement and bank instruction all carry the wrong net |
| [C-2](C-2.md) | Refunds never reach settlement/payouts/reconciliation | `processRefund` journals the ledger but nothing nets it into a batch or payout; admin's `/internal/refund-adjustment` route does not exist (404) |
| [C-3](C-3.md) | Settlement summary double-counts multi-capture | reconciliation numbers wrong for split captures |
| [C-4](C-4.md) | Reconciliation subtracts payouts without the payout debit | the month never ties |
| [C-5](C-5.md) | Capture discounts not applied on the payment-link path | discounted merchants overcharged on links |
| [C-6](C-6.md) | Discount adjustment uses only the latest capture event | multi-capture discounts wrong |

## All findings by group

| Group | Files | Count |
|---|---|---|
| Critical money | [C-1](C-1.md) [C-2](C-2.md) [C-3](C-3.md) [C-4](C-4.md) [C-5](C-5.md) [C-6](C-6.md) | 6 |
| Security & auth | [H-1](H-1.md) … [H-13](H-13.md) | 13 |
| Payment links | [P-1](P-1.md) … [P-4](P-4.md) | 4 |
| Money-path correctness | [M-1](M-1.md) … [M-12](M-12.md) | 12 |
| Reliability / concurrency | [R-1](R-1.md) … [R-7](R-7.md) | 7 |
| Validation / medium security | [S-1](S-1.md) … [S-9](S-9.md) | 9 |
| Operational / lower severity | [L-1](L-1.md) … [L-8](L-8.md) | 8 |
| Reporting gaps | [F-2](F-2.md) | 1 |

## Fixed work (already shipped — not part of the open ledger)

Verified fixed in the checkout (independent audit confirmation), with the
shipping commit in `CHANGELOG.md` and detail in `docs/EXPLANATIONS.md`:
B1 (CSV 10x), B4 (MDR closed-only), B5 (sweep idempotency + Bahrain month),
B6 (fee display), B7 (balance button → ledger rollup), B8 (refund ceiling),
B9/FP-209 (refund row lock), B11 (outbound sign-raw), B13 (cancel scope),
B16 (callback dedup), B18 (Bahrain window), B19 (test-mode isolation),
B22 (sargable analytics), B23 (keyset export), B24 (Dockerfiles),
F1 (route wired), F3 (refund webhook), F4 (web drawer), F5 (reason/matview),
plus the runtime fixes added after the audit: **dashboard CORS**, **web `/`
root redirect**, **dispatcher LISTEN reconnect**, **compose POSTGRES_URL
override**, and the amended seed (alpha rate, test-mode isolation).

> Statuses can change: when a finding is fixed, move its file out of this
> ledger (or flip Status to `Fixed (commit …)`) — the surviving truth is
> whatever the code does, not what this page said last week.

## Recommended fix order (from the audit)

1. C-1, C-2 — money correctness (payouts, refunds-in-settlement).
2. C-3, C-4 — finance cannot close the month otherwise.
3. H-1/H-2/H-3/H-4/H-6/H-7/H-10 — credential and authorization boundaries.
4. C-5/C-6/M-8/M-9 — one fee formula everywhere.
5. R-1/R-2/R-3/R-6 — concurrency and endpoint lifecycle.
6. H-12/H-13/R-4/R-5 — webhook/acquirer hardening.
7. Remaining validation, reporting and UI findings.
