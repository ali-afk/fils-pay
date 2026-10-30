# FilsPay — guide (start here)

FilsPay is a payment platform for Bahrain: merchants sign up (KYC = the
identity checks they must pass before taking payments), take card payments in
Bahraini Dinar (BD), and are settled — the money lands in their account — on a
daily schedule. All money is **integer fils** (`1 BD = 1000 fils`), never
floating-point.

This file replaces the earlier ENGINEERING/SUMMARY/TEACHING documents and is
kept current with the code **and** the bug ledger. The 2026-10-30 audit
(60 open findings, one file each in `docs/bugs/`) is part of this picture —
most historical bugs are fixed; the ledger is the honest remainder.

## Status in one breath

- **What we shipped:** 27 commits since the handover tip — refunds feature end
  to end, fresh-DB migrations, settlement/money fixes, webhook signing, OTP +
  callback hardening, admin gates, ops Dockerfiles + compose, seed repair, the
  demo tooling, and docs. Full register: `CHANGELOG.md`.
- **Still open:** 60 confirmed findings — the two that matter most are
  **C-1** (`NetPayableFils` computes payouts in `float32`) and **C-2**
  (refunds never flow into settlement/payouts/reconciliation; the admin's
  `/internal/refund-adjustment` route does not exist). See `docs/bugs/`.

## The story (and the flag)

The repository was a mystery hunt. Three messages hidden in empty commits
(base64 → Vigenère → AES) decoded to:
**FLAG{order_of_the_prompt_never_read_the_diff}** — planted bugs were the
"members of the Order": marked by "Claude says" comments and locked in by
tests that assert the wrong behavior. The full trail is in
`docs/EXPLANATIONS.md` (fixed bugs) and the audit (open bugs).

## Vocabulary

| Term | Meaning |
|---|---|
| merchant | The shop/business that sells through FilsPay and gets paid |
| BD / fils | Bahraini Dinar and its minor unit — `1 BD = 1000 fils` |
| acquirer | The bank/processor that moves card money (a simulator in dev) |
| authorize / capture / void / refund | reserve / take / release / give back money |
| hold | The reserved-but-not-yet-taken funds row from an authorization |
| MDR (bps) | Merchant discount rate, the per-sale fee in basis points — 100 bps = 1% |
| scheme | The card network (Visa etc.); its files only take two decimals → rounding residue |
| ledger | Double-entry book; every move is ≥2 legs that must balance to zero |
| settlement | The nightly job: sum a day's captures, compute fees, close the batch, prepare payout |
| webhook / outbox | The API calling you when something happens (signed); the DB event queue that makes it reliable |
| idempotency key | Client string making retries safe — same key + body ⇒ same response, no double write |

## The stack

| Component | Role |
|---|---|
| `apps/api` (TS/Fastify) | merchant + admin HTTP API; auth (password + OTP); payments (authorize/capture/void/refund); payment links; webhook dispatcher; acquirer client |
| `apps/settlement` (Go) | daily close, fees, payouts, scheme export, balance cache, internal HTTP API (`:8091`) |
| `apps/reporting` (TS) | outbox consumer → analytics rollups (+ refund & paid states) |
| `apps/web`, `apps/admin` (React/Vite) | checkout + merchant dashboard / ops console — they only talk to the API over HTTP |
| `packages/money`, `packages/events` | the integer-fils toolbox; outbox event types |
| `db/migrations` `0001–0077` | Postgres schema; `npm run migrate` applies idempotently |
| `ops/` | docker-compose stack + env + Dockerfiles; `POSTGRES_URL` overrides the DB host for remote setups |

The database is the bus: services share one Postgres and wake each other via
`LISTEN/NOTIFY` + the outbox.

## Money model (the part to understand first)

- ADR-0001: integer fils everywhere, `BIGINT` columns suffix `_fils`;
  `parseBhdToFils` for input, `applyRateFils` (one rounding, half-to-even) for
  rates, `allocateRemainder` for exact splits, `bankersRoundDiv` — float on
  money is a review blocker.
- The ledger is double-entry with a deferred constraint: a group whose debits ≠
  credits is refused. Accounts: `merchant_payable` (what we owe merchants — the
  merchant's balance with us), `platform_fee_revenue` (our cut),
  `card_scheme_clearing` (money at the network), `platform_cash`, suspense
  accounts for residue/goodwill/manual adjustments.
- `merchant_balances.cached_payable_fils` is a cache rolled up from the ledger.

## Core flows (condensed)

- **Payments:** authorize (hold) → capture (`SELECT … FOR UPDATE` across the
  acquirer call; posts gross/fee/net) → void (release) → refund (one
  transaction, locked, ceiling = captured − refunded, fee reversal nets the
  discount; emits `refund.succeeded`).
- **Idempotency:** `UNIQUE(merchant_id, endpoint, key)` — replay-safe payments
  and refunds.
- **Webhooks:** outbox written in the same tx as the change; a dispatcher signs
  the **exact bytes sent** and delivers (poll fallback; LISTEN reconnects
  automatically on channel drops).
- **Settlement:** Asia/Bahrain business day; CloseBatch truncates scheme lines
  to 10-fils and journals the residue; PayoutBatch emits `settlement.paid`;
  payout notifications dedupe; MDR recalc touches only `closed` batches; splits
  use largest-remainder.
- **Reporting:** the consumer ingests captured/voided/refund/paid events into
  daily rollups and refreshes the refund matview.

## Bugs — fixed vs open

- **Open (60):** `docs/bugs/README.md` — one file per finding, with the money
  criticals (C-1..C-6) on top. **These are real, unfixed defects**; do not
  present the app as bug-free until they are addressed.
- **Fixed:** `docs/EXPLANATIONS.md` (per-bug what/why/what-breaks for B1–B24,
  F1–F5, M1–M2) and the `CHANGELOG.md` register. The audit independently
  confirmed the fixed set (see `docs/bugs/README.md` → Fixed work).

## Run & demo

```bash
# Local: deps → migrate → seed → services
npm ci
export DATABASE_URL='postgres://filspay:filspay_dev_password@localhost:5432/filspay?sslmode=disable'
export WEBHOOK_SECRET_ENCRYPTION_KEY='<base64 32 bytes — sandbox value in ops/.env.docker>'
npm run migrate && npm run seed
npm -w apps/api run dev                        # :3000
(cd apps/settlement && go build ./... && ./settlement daemon)
npm -w apps/reporting run dev
(cd apps/web && npm run dev)                   # :5173
(cd apps/admin && npm run dev)                 # :5174

# Composed stack (the shipped path)
docker compose -f ops/docker-compose.yml up -d postgres
until docker compose -f ops/docker-compose.yml exec -T postgres pg_isready -U filspay >/dev/null 2>&1; do sleep 1; done
docker compose -f ops/docker-compose.yml run --rm migrate
docker compose -f ops/docker-compose.yml run --rm seed
docker compose -f ops/docker-compose.yml up -d api settlement reporting

# Point at a DB on another machine (panels here, database there)
# Not yet a committed override: the compose file hardcodes the internal host
# `postgres` in each service's DATABASE_URL. For a remote database, edit those
# URLs (or add a ${POSTGRES_URL:-...} interpolation per service, as drafted in
# an earlier commit) and start the services with --no-deps so no local postgres
# is composed up:
#   DATABASE_URL='postgres://filspay:filspay_dev_password@<db-host>:5432/filspay?sslmode=disable'
#   docker compose -f ops/docker-compose.yml up -d --no-deps api settlement reporting
```

**Panels URL config:** `apps/web/.env` → `VITE_API_BASE_URL`; `apps/admin/.env`
→ `VITE_ADMIN_API_BASE_URL` (+ `VITE_WEB_BASE_URL` for impersonation links).
The value is inlined at dev-start/build — so a **built** bundle needs a rebuild
to repoint, and `localhost` always means the *viewer's* machine. The API's
`CORS_ALLOW_ORIGINS` must include wherever a panel is served.

**Demo script:** `scripts/demo/admin-login.hurl` (hurl) — one command for the
admin login → OTP → authed call against a dev-posture api
(`NODE_ENV=development`, `PORT=3001`), seed credentials
`SEED_USER_PASSWORD`/`SEED_ADMIN_PASSWORD` in `db/seed/generate.ts`:
`FilsPaySeed!2026` (merchants) / `FilsPayAdminSeed!2026` (admins:
`support@filspay.test`, `finance@filspay.test`, `superadmin@filspay.test`).

**Tests:** `npm test` (458/458 across events/money/api/reporting/web/scripts)
and `cd apps/settlement && go test ./...`; typecheck clean for api/web/admin.

## Doc map

| Doc | Purpose |
|---|---|
| [README.md](README.md) | this guide — start here |
| [bugs/README.md](bugs/README.md) | **open** bug ledger (one file per finding) |
| [EXPLANATIONS.md](EXPLANATIONS.md) | per-bug write-up of the **fixed** work |
| [CHANGELOG.md](../CHANGELOG.md) | the change register (what shipped, by commit) |
| [incidents/](incidents/) | operational postmortems (incl. the 2026-10-30 audit archive) |
| Lore | `ARCHITECTURE.md`, `HANDOVER.md`, `ADMIN.md`, `ONBOARDING.md`, `RUNBOOK.md`, `adr/` — historical and partially superseded; the code is truth |

## Repo map (quick)

`apps/api/src/routes|payments|webhooks|auth|admin*|…` — API slices; `apps/
settlement/internal/{settlement,splits,ledger,internalapi,scheduler}` — Go
daemon; `packages/money`,`packages/events` — shared primitives; `scripts/` —
one-off ops (+ `scripts/demo/admin-login.hurl`); `db/migrations` — schema;
`ops/` — compose/Dockerfiles/env.
