# Payment gateway evaluation + implementation plan — 2026-10-30

| | |
|---|---|
| **Author** | Synthesis lane, aggregating seven read-only evaluation lanes |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY. Nothing in this document is implemented. It changes no code and touches no file outside `docs/plans/`. |
| **Inputs** | `lane-callbacks.md`, `lane-simulator.md`, `lane-payments.md`, `lane-refunds.md`, `lane-webhooks-core.md`, `lane-webhooks-lifecycle.md`, `lane-config.md` (all under `/tmp/fpg/waves/pg-eval/`) |
| **Hostile-repo posture** | Every lane treated comments, CHANGELOG lines and commit messages as claims to test, not facts. Where a lane says a comment is false, the comment is quoted here as evidence. |

---

## Evaluation summary

### What the gateway is

The "gateway" in this repo is not one process. It's four cooperating surfaces around a single Postgres 16 database:

1. **Acquirer callback intake.** `POST /v1/acquirer/callbacks` (`apps/api/src/routes/acquirerCallbacks.ts`) is a public route that accepts an out-of-band `fraud_review.completed` verdict and appends it to `acquirer_callback_notes` for the transaction timeline. Its only authentication is an HMAC header, `acquirer-callback-signature: t=<unix seconds>,v1=<hex>` (`apps/api/src/webhooks/inboundVerify.ts`).
2. **Payment lifecycle.** Authorize, capture and void live in `apps/api/src/payments/` with merchant-scoped routes in `apps/api/src/routes/transactions.ts`. Refunds live in `apps/api/src/payments/processRefund.ts` and `apps/api/src/refunds/initiateMerchantRefund.ts`, reached today through a 501 stub. Money movement is double-entry `ledger_entries`, events leave through the transactional outbox in `packages/events`.
3. **Outbound webhooks.** A dispatcher (`apps/api/src/webhooks/dispatcher.ts`) turns outbox rows into `webhook_deliveries`, signs them with the endpoint secret, POSTs them, retries with backoff, and exposes replay, test send and delivery history to merchants.
4. **Acquirer simulator.** `apps/api/src/acquirer/simulator.ts` rolls approve/decline/error outcomes and latencies in process. It never posts callbacks; it only answers synchronous authorize/capture/refund calls.

### Verdict per area

| Area | Verdict |
|---|---|
| **Acquirer callbacks** | Not production safe. Signature checking is off by default in every environment, the signing secret is committed to a tracked env file, timestamps aren't checked, dedupe claimed in docs and commits doesn't exist in the tree, and `outcome` is unvalidated. The endpoint is a public, attacker-controlled write surface into a fraud timeline. |
| **Payment lifecycle** | State machine and ledger arithmetic are sound, and there is no double-capture path in the DB layer. The exceptions are serious: capture idempotency can replay one transaction's success for another, and capture/void have no role gate, so finance, support and admin impersonation can move money. |
| **Refunds** | The helper layer contains four money-moving defects on main: authorized-amount ceiling, no row lock, gross fee reversal, and a NOT NULL failure after the acquirer has already refunded. The route is still 501, which currently masks them. Cross-merchant refund is possible in the helper. |
| **Webhooks core** | The design is mostly sound (transactional outbox, partial unique index on creation, at-least-once retries with a stable id, AES-GCM secret storage, constant-time outbound verification). Delivery availability and evidence are the weak points: no row claim, a poison-row hot loop, duplicate disbursement records, and a LISTEN reconnect that exists only in an unmerged commit. |
| **Webhooks lifecycle** | CRUD, merchant scoping and secret show-once handling are correct. Deleting an endpoint with delivery history 500s on an FK, the URL validator has no SSRF filtering, replay breaks the documented dedupe contract, and several comments describe protections that don't exist. |
| **Simulator** | Good enough to drive a demo, not a migration contract. Default RNG is crypto-backed; a configured seed silently makes outcomes deterministic and non-crypto in any environment. Idempotency caches are unbounded and under-keyed, and the decline/error branches are barely tested. |
| **Configuration and ops** | The shipped dev and compose paths don't boot as documented: the built-in dev key is 34 bytes (would have to be 32), `.env.docker` is never loaded by compose, and production mode demands two secrets the stack never supplies. |

### Findings table

Severity is the highest assigned by any contributing lane. Where lanes disagreed (SSRF is medium in one, high in another), the higher rating is used and the disagreement is stated in that finding.

| # | Finding | Severity | Primary evidence |
|---|---|---|---|
| 1 | `refund.succeeded` is produced but consumed by nobody (contradiction resolution) | high | `processRefund.ts:246`, `dispatcher.ts:28-32`, `envelope.ts:9`, `runConsumerPass.ts:9-12` |
| 2 | Acquirer callbacks accepted unsigned by default in every environment | critical | `config.ts:259`, `inboundVerify.ts:50-55` |
| 3 | Acquirer signing secret committed to the repo | critical | `ops/.env.docker:19`, `.gitignore` |
| 4 | Refund ceiling uses the authorized amount, not captured | critical | `processRefund.ts:86-90` |
| 5 | Refund has no row lock and splits work across two transactions | critical | `processRefund.ts:73-78`, `153`, `199-201` |
| 6 | Capture idempotency hash omits the transaction id | high | `capture.ts:44`, `92`, `idempotency.ts:150-154` |
| 7 | Capture/void have no role gate; impersonation can write | high | `routes/transactions.ts:95,123`, `requireMerchantAuth.ts:127-146` |
| 8 | Refund initiation never checks the transaction belongs to the merchant | high (latent) | `initiateMerchantRefund.ts:63-71` |
| 9 | Refund fee reversal is gross, not net of discount | high | `processRefund.ts:113-119`, `discountAdjustment.ts:81` |
| 10 | Omitted refund `reason` writes NULL after the acquirer refunded | high | `processRefund.ts:189`, `0070_refund_reason_default.sql:6-9` |
| 11 | Inbound callback timestamps are never checked for freshness | high | `inboundVerify.ts:32,62` |
| 12 | Callback dedupe doesn't exist; the "fixed" commit isn't in HEAD | high | `acquirer/callbacks.ts:38-49`, `0051_acquirer_callback_notes.sql:14-27` |
| 13 | Callback `outcome` is never validated; comment invents an enum | high | `acquirerCallbacks.ts:10-12,43-55`, `acquirer/callbacks.ts:11` |
| 14 | `occurredAt` is client data in `received_at`, no ISO validation | medium | `acquirerCallbacks.ts:47`, `acquirer/callbacks.ts:46-48` |
| 15 | Inbound HMAC comparison isn't constant-time | medium | `inboundVerify.ts:40-42` |
| 16 | Inbound signature covers re-serialized JSON, not wire bytes | medium | `inboundVerify.ts:62` |
| 17 | `withCallbackRetry` retries permanent failures at fixed 50 ms | low | `acquirer/callbacks.ts:63-76` |
| 18 | Simulator never produces or signs a callback | low | `acquirer/simulator.ts` (full file) |
| 19 | `merchant_daily_volume` is never updated on capture | high | `capture.ts:14-46` (function never called), `analytics/query.ts:110-125` |
| 20 | Dispatcher LISTEN reconnect exists only in an unmerged commit | high | `dispatcher.ts:300-331`, incident doc, `a808bf7` not an ancestor |
| 21 | Step B has no row claim or `SKIP LOCKED` | high | `dispatcher.ts:219-227` |
| 22 | Payout disbursement rows duplicate per endpoint and per replay | high | `dispatcher.ts:37-42,160-163`, `payoutDisbursement.ts:11-17` |
| 23 | Deleting an endpoint with deliveries 500s on an FK | high | `cancel.ts:21-22`, `0022_webhook_deliveries.sql:5-6` |
| 24 | Built-in dev webhook key is 34 bytes, so dev boot throws | high | `config.ts:153,170-174` |
| 25 | Compose never loads `ops/.env.docker` | high | `docker-compose.yml` (no `env_file`), `ops/README.md:25` |
| 26 | Production compose lacks two secrets the API requires | high | `ops/.env.docker:10`, `config.ts:165,187-189` |
| 27 | Webhook URL validation has no IP filtering; fetch follows redirects | high | `create.ts:15-26`, `transport.ts:38-40` |
| 28 | Throw-path deliveries hot-loop forever and can starve the queue | high | `dispatcher.ts:233-243`, `224-227` |
| 29 | Seeded non-crypto RNG is reachable in production | medium | `rng.ts:12-25`, `config.ts:224-226` |
| 30 | Simulator idempotency caches are unbounded and keyed by key alone | medium | `simulator.ts:82-89,122` |
| 31 | Outbound signature covers canonical JSON, not the bytes sent | medium | `sign.ts:36-37`, `dispatcher.ts:172` |
| 32 | Replay mints a new `delivery_event_id` | medium | `replay.ts:46-49`, `headers.ts:10-13`, `0022:43-44` |
| 33 | Refund state keeps `partially_captured` after full refund | medium | `refundState.ts:16-18,47-48` |
| 34 | `POST /v1/refunds` is still a 501 stub | medium | `routes/refunds.ts:22-24` |
| 35 | `expire_holds.ts` deletes hold history, including a race window | medium | `scripts/expire_holds.ts:29-37`, `authorize.ts:113-114` |
| 36 | Acquirer idempotency key embeds `attemptCount` | medium | `capture.ts:173-179`, `idempotency.ts:156-163` |
| 37 | Backoff test asserts exact values from a jittered function | medium | `dispatcher.ts:53-60`, `dispatcher.test.ts:195-196,215-216` |
| 38 | Simulator decline/error branches and magic-PAN claim are untested | medium | `simulator.test.ts:27-31,63-67,88-96` |
| 39 | Simulator result types don't model a real acquirer | medium | `types.ts:3-9,23,28-31` |
| 40 | Negative or fractional `amountFils` becomes a 500 | low | `routes/transactions.ts:79,103`, `packages/money/src/fils.ts:33-41` |
| 41 | Dead `v1/routes/transactions.ts` holds an unauthenticated capture | low | `v1/routes/transactions.ts:14-44` |
| 42 | Test send ignores endpoint status | low | `testSend.ts:40,48-64` |
| 43 | `secretCrypto.ts` docblock claims deterministic encryption | low | `secretCrypto.ts:29,32` |
| 44 | Batch replay accepts `status=succeeded` despite the comment | low | `replayBatch.ts:19-20,78-84` |
| 45 | `parsePromotionalDiscountFils` uses `parseFloat` and `*100` | low | `discountAdjustment.ts:12-17` |
| 46 | `docs/README.md` points at a key that isn't in `ops/.env.docker` | low | `docs/README.md:112`, `ops/.env.docker` |
| 47 | "Flaky once on my machine" note on a deterministic test is baseless | low | `simulator.test.ts:123-150` |

Counts: 4 critical, 19 high, 14 medium, 10 low (47 total).

---

## Findings

Each finding carries the evidence as the lanes recorded it, the claims it contradicts, why it matters commercially or operationally, and a priority. Priority is `P0` (before any hosted demo or real acquirer), `P1` (before merchant-facing launch), `P2` (next hardening pass), `P3` (cleanup).

### Finding 1 (contradiction resolution): `refund.succeeded` is produced but never consumed

**Resolved truth:** the event is **produced, never dispatched, and never reported**. It is not "absent because refunds haven't shipped". Refunds' producer half shipped long ago.

**Evidence:**
- Producer is live: `apps/api/src/payments/processRefund.ts:246` enqueues `eventType: "refund.succeeded"` with `aggregateType: "transaction"`. The outbox type union includes it: `packages/events/src/outbox.ts:13`.
- The dispatcher's eligibility list contains only three types: `apps/api/src/webhooks/dispatcher.ts:28-32` (`transaction.captured`, `transaction.voided`, `settlement.paid`). Step A filters on that list (`dispatcher.ts:92`), so refund rows are never selected.
- The envelope can't build it even if selected: `apps/api/src/webhooks/envelope.ts:9` has no variant, and `buildEnvelope` throws on unknown types (`envelope.ts:81-82`). The ordering warning is real: adding eligibility first stalls Step A (`dispatcher.ts:26`).
- Reporting skips it: `apps/reporting/src/consumer/runConsumerPass.ts:9-12` lists `transaction.captured`, `transaction.voided`, `settlement.batch_closed`, with the comment at `:8` "refund.succeeded not here yet".
- Code-path hits are five: `outbox.ts:13`, `runConsumerPass.ts:8`, `dispatcher.ts:25`, `processRefund.ts:246`, and `processRefund.test.ts:440,456`. Repo-wide text hits also include `db/seed/fixtures/production_seed.sql`, `.cursorrules:61`, `apps/settlement/internal/settlement/payout_notify.go:76`, `docs/ONBOARDING.md:70`, `docs/README.md:83`, `docs/EXPLANATIONS.md`, and `docs/HANDOVER.md:18`. Only the first list is live code; the rest are stale docs, fixtures, or comments.

**Contradicts:**
- `CHANGELOG.md:24-25` ("`refund.succeeded` webhook (envelope case + eligibility)") and `CHANGELOG.md:43-44` (reporting consumes it). Both false against HEAD; the cited commits (`5fe1d4a`, `a82656d`) are not ancestors.
- `docs/HANDOVER.md:17-19` ("on the webhook eligible list"). False.
- `packages/events/src/outbox.ts:12` ("so the dispatcher handles it? (yes per claude)"). False.
- `AGENTS.md:59-61` says the type is "intentionally absent" and will "ship in v1.9". Accurate about eligibility and envelope, but misleading about the producer, which is already writing undeliverable rows, and stale about timing: 1.9.0 shipped 2026-07-21, 1.9.2 on 2026-09-12 (`CHANGELOG.md:65,84`).
- `dispatcher.ts:25` says "add refund.succeeded here when refunds ship". Refunds shipped; the entry is still missing.

**Why it matters:** every successful refund writes an outbox row nothing advances. Merchants get no refund webhook, finance reporting never sees refunded volume, and `outbox_events` grows without a consumer. The docs claim the opposite, so monitoring built on docs shows green.

**Priority:** P1 for the dispatch/reporting decision, P2 for producer suppression or dead-letter observability if the decision is "not yet".

### Finding 2: Acquirer callbacks are accepted without any signature by default

**Evidence:** `apps/api/src/config.ts:259` sets `acquirerCallbackRequireSignature` from `parseBoolEnv(..., false)`, with no `NODE_ENV` gate. `apps/api/src/webhooks/inboundVerify.ts:50-55` returns `{ valid: true }` when the header is absent and the flag is off. The route is public and mounted as such: `apps/api/src/app.ts:72`. `ops/.env.docker` sets the signing secret (`:19`) but never the flag. A repo-wide grep finds no file that sets it to `true`. The current behavior is locked by `apps/api/src/routes/acquirerCallbacks.test.ts:124-131`, which asserts a 200 for an unsigned callback.

**Contradicts:** `routes/acquirerCallbacks.test.ts:122` ("prod rejects"), `docs/EXPLANATIONS.md:232-233` ("the shipped flag=true"), `docs/bugs/H-12.md:18`, and `app.ts:71` ("inboundVerify rejects unsigned requests"). Overlap: `lane-callbacks` F-1 and `lane-config` F-1 describe the same defect; both are cited here.

**Why it matters:** anyone who knows a transaction UUID can POST a forged verdict with an arbitrary `outcome` and `note`, and it lands on the timeline support and finance read (`apps/api/src/acquirer/callbacks.ts:21-22`). It's also an unauthenticated DB write surface.

**Priority:** P0.

### Finding 3: The acquirer signing secret is committed to the repo

**Evidence:** `git ls-files ops/.env.docker` returns the path, so the file is tracked. `ops/.env.docker:19` contains `ACQUIRER_CALLBACK_SIGNING_SECRET=acqsec_sandbox_f8c3a1e6b9d24f7081c5e3a9b7d4f602`. `.gitignore` lists `.env` and `.env.local` but not `.env.docker`; a pattern `.env` does not match `.env.docker`. This is the same variable `config.ts:192` and `acquirerCallbacks.ts:60` verify against, and the repo is planned to go public (`docs/plans/submission-doc-and-slides-2026-10-30.md:146`).

**Contradicts:** `ops/.env.docker:7` ("this file is gitignored"), `:8-9` ("asked copilot, `.env` matches `.env.docker` as a prefix"), and `:13-16` ("not a production credential").

**Why it matters:** with the secret in public source, HMAC forgery is trivial and enabling the signature flag (Finding 2) becomes cosmetic.

**Priority:** P0.

### Finding 4: The refund ceiling is the authorized amount, so a partial capture can be refunded past what was taken

**Evidence:** `apps/api/src/payments/processRefund.ts:86-90` computes `refundableFils = subtractFils(amountAuthorized, refundedFils)`. `refundValidation.ts:44` enforces only that ceiling. `refundValidation.test.ts:55` and `:73` lock the behavior in as intentional. The in-code reassurance at `refundState.ts:46` ("refundValidation stops the second refund since refunded == captured") is false because validation gates on authorized minus refunded.

**Contradicts:** `CHANGELOG.md:22` ("captured-based ceiling"), commit `f8846e8` message (fix not on main).

**Why it matters:** an auth of 10,000 fils with a 4,000 fils capture can refund up to 10,000. The refund journals debit `merchant_payable` for the full amount (`processRefund.ts:206-210`), leaving negative payable for money the acquirer never collected.

**Priority:** P0 (before the refund route is wired).

### Finding 5: Refunds take no row lock and split the work across two transactions

**Evidence:** `processRefund.ts:73-78` reads the transaction without `FOR UPDATE`, unlike capture (`capture.ts:123`) and void (`void.ts:45`). Transaction 1 commits, the acquirer call runs outside any transaction (`processRefund.ts:146-150`), then a separate transaction journals (`:153`) and blindly writes `refunded_fils` from the earlier unlocked read (`:165,199-201`). Two concurrent refunds with different idempotency keys both read zero refunded and both proceed. `processRefund.test.ts:255` explicitly punts on the concurrent case.

**Contradicts:** `CHANGELOG.md:22-23` ("single transaction + FOR UPDATE across the acquirer call"), commit `f8846e8` (fix not on main).

**Why it matters:** double refund, and a `refunded_fils` column that disagrees with the sum of `refunds` rows. Idempotency only serializes the same key (`idempotency.ts:104-131`).

**Priority:** P0.

### Finding 6: Capture idempotency can replay one transaction's success for another

**Evidence:** `apps/api/src/payments/capture.ts:92` hashes only `{ amountFils }`, and `capture.ts:44` uses the constant endpoint `"transactions.capture"`. The uniqueness scope is `(merchant_id, endpoint, key)` (`0019_idempotency_keys.sql:29`, `idempotency.ts:118-124`). On a completed row, the stored response body is returned verbatim (`idempotency.ts:150-154`), and the replay branch does no work under any lock (`capture.ts:108-112`, where the comment reads "No row lock is ever taken on this call.").

**Contradicts:** `0019_idempotency_keys.sql:31-33` ("request_hash covers the transaction id as well"), `routes/transactions.test.ts:218-219` ("keys are per transaction").

**Why it matters:** a client reusing a key across two transactions gets the first transaction's 200 response for the second. The API reports a capture that never happened; the authorization hold stays.

**Priority:** P0.

### Finding 7: Capture and void have no role gate, and impersonation can write

**Evidence:** `apps/api/src/routes/transactions.ts:95` and `:123` use only `requireMerchantAuth`. Sibling writes chain `requireMerchantRole` (`routes/settlement.ts:61,79`, `routes/webhooks.ts:58,90,...`, `routes/paymentLinks.ts:78,102`). `requireMerchantAuth.ts:76-98` accepts an admin impersonation grant, and `requireMerchantWriterActor` (`:127-146`) performs no role check, mapping `admin_impersonation` to a merchant session (`:133`).

**Contradicts:** `payments/void.ts:40-41` ("route does roles"), `routes/transactions.ts:91-92` ("impersonation is read-only"), `requireMerchantAuth.ts:128` ("impersonation can't reach write routes"), `apps/api/src/admin/impersonation.ts:91` ("a grant is view-only").

**Why it matters:** finance and support users, and any impersonating admin, can capture funds and void holds. The audit trail records the write as `merchant_session`, losing accountability.

**Priority:** P0.

### Finding 8: Refund initiation never checks the transaction belongs to the calling merchant

**Evidence:** `apps/api/src/refunds/initiateMerchantRefund.ts:63-66` selects by `id` only, then calls `processRefund` with the target row's `merchant_id` (`:70-71`). `assertRefundRequestScope` (`:20-25`) only compares session merchant to path merchant. `initiateMerchantRefund.test.ts:170` admits the hole: "another merchant's existing transactionId should also 404. currently refunds it".

**Contradicts:** the wiring commit's comment ("The merchant is always the authenticated one"), `CHANGELOG.md:21`.

**Why it matters:** merchant B can refund merchant A's transaction by id. Latent while the route is 501, exploitable the moment wiring lands.

**Priority:** P0 before wiring.

### Finding 9: Refund fee reversal is gross rather than net of discount

**Evidence:** `processRefund.ts:113-119` sums only credits to `platform_fee_revenue`. The negotiated discount is booked as a debit in the same account (`discountAdjustment.ts:81`), so it's excluded. `feeReversedFils` is then computed proportionally from the gross fee (`processRefund.ts:171`, `packages/money/src/fils.ts:260-273`).

**Contradicts:** `CHANGELOG.md:24` ("net-of-discount fee reversal"), commit `f8846e8` (fix not on main).

**Why it matters:** every refunded, discount-priced sale returns the discount to the merchant and leaves `platform_fee_revenue` negative on that transaction. Silent revenue leak.

**Priority:** P0.

### Finding 10: An omitted refund reason writes NULL after the acquirer already refunded

**Evidence:** `processRefund.ts:189` passes `input.reason ?? null`. Migration `0070_refund_reason_default.sql:6-9` sets a default and adds `CHECK (reason IS NOT NULL) NOT VALID`, which still enforces new rows. An explicit NULL overrides the default, so the journaling transaction (`processRefund.ts:153`) fails after the acquirer call (`:146-150`). The committed idempotency claim stays `in_progress`, so retries get 409 forever.

**Contradicts:** `CHANGELOG.md:24` ("reason defaulting"). Commit `f8846e8` corroborates: pre-fix, "10 failing on the reason check alone".

**Why it matters:** worst-possible ordering. Money moves at the acquirer, nothing is journaled, the response is 500, and the request becomes unretryable without manual DB work.

**Priority:** P0.

### Finding 11: Inbound callback timestamps are never checked, so signed callbacks replay forever

**Evidence:** `inboundVerify.ts:32` says freshness isn't checked. The parsed `t` feeds the HMAC (`:62`) but is never compared to `Date.now()`. The only reasons are `malformed_header` and `signature_mismatch` (`:33`). The outbound verifier does enforce a 300 s window (`sign.ts:101-103`). `acquirerCallbacks.test.ts:103` notes stale timestamps are uncovered.

**Contradicts:** the header contract at `routes/acquirerCallbacks.ts:23`, which implies Stripe-style freshness. Overlap: `lane-callbacks` F-3 and `lane-config` F-2, same defect.

**Why it matters:** any captured signed callback is acceptable indefinitely. With Finding 12 it inserts duplicate notes; even fixed, stale verdicts are re-processed.

**Priority:** P0 with Findings 2 and 12.

### Finding 12: The claimed callback dedupe does not exist, and the "fix" commit isn't in history

**Evidence:** `apps/api/src/acquirer/callbacks.ts:38-49` is a plain `INSERT` with no `ON CONFLICT`, and returns `Promise<void>`. `db/migrations/0051_acquirer_callback_notes.sql:14-24` has no unique constraint on `callback_id` or `(transaction_id, callback_id)`. The migration comment at `:29-32` claims `processed_events` and a "done" FP-238 index; no `processed_events` table exists, and migrations stop at `0072` (no `0073`). Commit `0446569` contains the real fix but `git merge-base --is-ancestor 0446569 HEAD` returns false. Commit `bf66bf2` admits "They are not" in its own message. The SELECT-then-INSERT pair isn't transactional, so concurrent duplicates both insert.

**Contradicts:** `docs/EXPLANATIONS.md:229-231`, the asserted regression test (absent), and `0051:29-32`.

**Why it matters:** real gateway redelivery of the same callback duplicates timeline notes, and replay compounds it.

**Priority:** P0.

### Finding 13: `outcome` is never validated, and the route comment invents an enum

**Evidence:** `routes/acquirerCallbacks.ts:10-12` claims validation against `"approved" | "rejected"`. The actual check (`:43-55`) is truthiness only; `:72` is a compile-time cast. The real union is `"cleared" | "confirmed_fraud"` (`apps/api/src/acquirer/callbacks.ts:11`). The DB column has no check (`0051:19-20`).

**Contradicts:** the route comment and `docs/EXPLANATIONS.md:231-232`.

**Why it matters:** arbitrary strings land on the fraud timeline. With Finding 2, a forged "cleared" can mask a transaction the acquirer actually flagged.

**Priority:** P0.

### Finding 14: `occurredAt` goes into `received_at` with no ISO validation

**Evidence:** `routes/acquirerCallbacks.ts:47` only checks truthiness. `acquirer/callbacks.ts:46-48` binds `callback.occurredAt` to `received_at`, typed `TIMESTAMPTZ NOT NULL` (`0051:22`). Unparseable values fail after 3 retries and become a 500 (`errorHandler.ts:35`). The column name implies server receipt time, but the value is client-supplied and backdatable.

**Contradicts:** `docs/EXPLANATIONS.md:231-233` ("ISO validation, server-side received_at").

**Why it matters:** a real gateway sending epoch seconds or RFC-2822 turns a valid callback into a 500, and a forged callback controls the displayed timestamp.

**Priority:** P1.

### Finding 15: Inbound HMAC comparison is not constant-time

**Evidence:** `inboundVerify.ts:40-42` uses `Buffer.compare` behind a function named `constantTimeEquals`; it short-circuits on the first differing byte. The repo already has `timingSafeEqualHex` (`apps/api/src/lib/crypto.ts:12-18`), used by the outbound verifier (`sign.ts:96`).

**Contradicts:** the function's own name, `constantTimeEquals` (`inboundVerify.ts:40`), and the established repo pattern in `lib/crypto.ts:12-18`.

**Why it matters:** defense in depth on the only auth boundary of a public endpoint.

**Priority:** P1.

### Finding 16: Inbound signature covers re-serialized JSON, not the wire bytes

**Evidence:** `inboundVerify.ts:62` signs `` `${parsed.timestamp}.${JSON.stringify(payload)}` `` over the parsed body. The outbound signer deliberately uses canonical JSON (`sign.ts:36`, contract at `sign.ts:6-7`). The header format is a custom convention justified only by a comment (`routes/acquirerCallbacks.ts:6`), with the integration guide absent from the repo.

**Contradicts:** `docs/EXPLANATIONS.md:233` (production-hardened framing). No code produces a real signed callback (Finding 18), so this was never exercised.

**Why it matters:** any mismatch between the acquirer's signed bytes and `JSON.stringify` of the parsed body breaks verification against a real gateway, or pushes operators to disable it (already the default).

**Priority:** P1.

### Finding 17: `withCallbackRetry` retries permanent failures with fixed 50 ms sleeps

**Evidence:** `acquirer/callbacks.ts:63-76` retries any thrown error, including `NotFoundError("transaction_not_found")`, at fixed `delayMs = 50`, no jitter, then rethrows. Wired at `routes/acquirerCallbacks.ts:76`.

**Contradicts:** no explicit doc claim. The retry contract is honored mechanically, but retrying permanent errors contradicts what a retry is for.

**Why it matters:** a permanent 404 costs three queries and 100 ms of sleep, and the retry re-runs the non-transactional SELECT plus INSERT, widening Finding 12's race.

**Priority:** P2.

### Finding 18: The simulator never produces or signs a callback

**Evidence:** `routes/acquirerCallbacks.ts:30-34` says the acquirer posts verdicts back. `acquirer/simulator.ts` implements only authorize, capture and refund, with no signing or HTTP. A repo-wide search finds `fraud_review.completed` in the route, `callbacks.ts`, the two test files, the migration CHECK constraint at `0051:19`, and two docs (H-12.md, archive/audit-bugs) — but never in the simulator.

**Contradicts:** `routes/acquirerCallbacks.ts:30-34` (simulator posts verdicts back) and `docs/EXPLANATIONS.md:233` (shipped hardening claims).

**Why it matters:** the signature path has only ever seen hand-built test payloads, so Findings 11 and 16 will surface cold against a real gateway.

**Priority:** P2.

### Finding 19: `merchant_daily_volume` is never updated on capture

**Evidence:** `payments/capture.ts:14-46` defines `recordCaptureMetric` but never calls it; a tree-wide search finds only the definition. `analytics/query.ts:110-125` and `routes/reporting.ts:82` read the table. The only other writer is the admin truncate-and-rebuild at `admin/reportingRebuild.ts:13-44`.

**Contradicts:** the implied freshness of `GET /v1/analytics/volumes`; no doc says the table is rebuild-only. The dead upsert at `capture.ts:14-46` itself implies the incremental path was intended.

**Why it matters:** volumes and reporting drift from the ledger until someone runs an admin rebuild. Silent, and it looks like data, not a bug.

**Priority:** P1.

### Finding 20: The dispatcher LISTEN reconnect exists only in an unmerged commit

**Evidence:** `dispatcher.ts:300-331` registers only `"error"` and `"notification"` handlers. There is no `"end"` handler and no reconnect timer; a grep for reconnect symbols returns zero. `stop()` does exist and does `clearInterval` plus `listenClient.end()`, but it holds no reconnect-related cleanup. The incident doc `docs/incidents/dispatcher-listen-drop-2026-10-30.md` says "Resolved" and cites `a808bf7`, but `git merge-base --is-ancestor a808bf7 HEAD` is false, and the file's log is `647ada5` (created it), `8403d62`, `7fd7a95`; `c2f3627` (2025-09-18, the webhooks module commit) never touched the file.

**Contradicts:** the incident doc's status and fix description, `CHANGELOG.md:27-28`.

**Why it matters:** after any Postgres blip, notifications die for the process lifetime and delivery silently falls back to the 5 s poll.

**Priority:** P1.

### Finding 21: Step B has no row claim and no `SKIP LOCKED`

**Evidence:** `dispatcher.ts:219-227` does an unlocked SELECT of due pending rows, POSTs (`:163-171`), then updates only after the send (`:182-212`). Comments at `:217-218` admit the single-replica assumption; `index.ts:29` claims `SKIP LOCKED` exists, but no query in the file has it. The in-process `running` flag (`:287-297`) is per process.

**Contradicts:** `index.ts:29` (claims `SKIP LOCKED` makes multiple replicas safe) and `dispatcher.ts:218` (staging ran two replicas "so it's fine").

**Why it matters:** two replicas both deliver the same row, with different signatures, and race the terminal UPDATE. Last writer wins, so attempt history is lost and the stored outcome may disagree with what the receiver saw. Step A creation is safe; Step B isn't.

**Priority:** P1, P0 if more than one API replica is ever run.

### Finding 22: Payout disbursement rows duplicate per endpoint and per replay

**Evidence:** `dispatcher.ts:37-42` and `:160-163` run `recordPayoutDisbursementEffect` for `settlement.paid` whenever `attempt_count === 0`, which is once per delivery row. `payoutDisbursement.ts:11-17` inserts unconditionally with a fresh `disb_` reference. `0057_settlement_payout_disbursements.sql:9-19` has no unique constraint on `settlement_batch_id`; its comment at `:20` says "one row per paid batch". Multiple endpoints mean multiple rows; a replay resets `attempt_count` to 0 (`0022:14`, `replay.ts:51-62`) and records another.

**Contradicts:** `CHANGELOG.md:27-28` ("payout-disbursement dedup"), `0057:20`.

**Why it matters:** the audit record of what was "disbursed" becomes unreliable. No reader of the table exists today, so it's record pollution, not yet double payout.

**Priority:** P1.

### Finding 23: Deleting an endpoint with delivery history throws an FK violation and returns 500

**Evidence:** `webhooks/cancel.ts:21-22` hard-deletes. `0022_webhook_deliveries.sql:5-6` declares `endpoint_id UUID NOT NULL REFERENCES webhook_endpoints (id)` with default `NO ACTION`, and no migration alters it (checked all 66). With at least one delivery, Postgres raises 23503 and `plugins/errorHandler.ts:30-33` maps unknown errors to 500. The route test only deletes an endpoint with no deliveries (`routes/webhooks.test.ts`).

**Contradicts:** `cancel.ts:3,10-16`, `routes/webhooks.ts:103-104` ("ON DELETE CASCADE added in 0047", which is a merchants column), and `cancel.ts:16` ("FK is ON DELETE SET NULL (0029)", which is a payment_links index).

**Why it matters:** the common delete case 500s. The comments claim it was fixed, so review trusts them and ships a broken path.

**Priority:** P1.

### Finding 24: The built-in dev webhook key is 34 bytes, so a plain dev boot throws

**Evidence:** `config.ts:153` sets `DEV_FALLBACK_WEBHOOK_KEY_B64` to a value decoding to `test-key-for-dev-only-not-for-prod` (34 bytes). `parseWebhookSecretEncryptionKey` (`:170-174`) throws unless the decoded length is exactly 32, and the fallback is used for non-production (`:249-251`).

**Contradicts:** `ops/docker-compose.yml:73-74`, `ops/README.md:58`.

**Why it matters:** the documented dev and compose dev paths can't boot without exporting a valid key.

**Priority:** P1 (it blocks the demo).

### Finding 25: Compose never loads `ops/.env.docker`

**Evidence:** `ops/docker-compose.yml:8-10` says compose picks the file up automatically, and `ops/README.md:25` repeats it. The compose file contains no `env_file:` at all, and the `api` service only sets `DATABASE_URL` and `SETTLEMENT_INTERNAL_URL` (`:79-88`). Compose only auto-reads `.env`, not `.env.docker`.

**Contradicts:** `ops/docker-compose.yml:8-10` and `ops/README.md:25`, both of which say compose loads the file automatically.

**Why it matters:** every "where the value comes from" answer in the ops docs is wrong for the shipped stack. `NODE_ENV`, the signing secret and `PORT` never arrive.

**Priority:** P1.

### Finding 26: Production compose lacks two secrets the API requires

**Evidence:** `ops/.env.docker:10` sets `NODE_ENV=production`. `config.ts:165` requires `WEBHOOK_SECRET_ENCRYPTION_KEY` unconditionally, and `:187-189` requires `SETTLEMENT_INTERNAL_TOKEN` in production. Neither appears in the compose `environment:` blocks or in `.env.docker`.

**Contradicts:** `ops/README.md:52-64` (required settings and the MK note that only the hosted box key is missing).

**Why it matters:** the documented quick start and hosted-demo instructions don't produce a bootable API.

**Priority:** P1.

### Finding 27: Webhook URLs have no IP filtering and outbound fetch follows redirects

**Evidence:** `create.ts:15-26` validates only that the URL parses, uses http or https, and is https in production. No loopback, private, link-local or metadata check. `transport.ts:38-40` comments claim upstream SSRF protection; the fetch has no `redirect` option, so it follows. `testSend.ts:59-68` returns up to 2 KB of the receiver's body, and `deliveries.ts:164-169` persists and exposes the same excerpt.

**Contradicts:** `create.ts:13`, `transport.ts:38`, `routes/webhooks.ts:143-146` ("harmless", "blocks private hosts"). Overlap: `lane-webhooks-core` F-6 rates this medium, `lane-webhooks-lifecycle` F-1 rates it high. The higher rating is used because test send is a synchronous read oracle from the merchant plane.

**Why it matters:** a merchant can point an endpoint at `settlement:8091`, a metadata IP, or a public host that redirects internally, and read the response. On a payment platform that's an internal network scanner with exfil.

**Priority:** P1.

### Finding 28: Throw-path deliveries hot-loop forever and can starve the queue

**Evidence:** `dispatcher.ts:233-243` catches a thrown row error and deliberately leaves `status`, `attempt_count` and `next_attempt_at` untouched. `attemptOneDelivery` throws on `decryptSecret` (`:153-156`) and on disbursement DB errors. Step B orders by `next_attempt_at ASC LIMIT 100` (`:224-227`), so a poison row keeps the oldest timestamp and stays at the head, retried every 5 s. Rotating `WEBHOOK_SECRET_ENCRYPTION_KEY` poisons every stored secret at once, and the incident doc's root cause is exactly that symptom.

**Contradicts:** the "self-heals" comments at `:219-243`, which are true only for transient failures.

**Why it matters:** delivery can go dark platform-wide, or starve behind 100 poison rows, with no terminal state and no alert.

**Priority:** P1.

### Finding 29: A seeded, non-crypto RNG is reachable in production

**Evidence:** `rng.ts:14-25` implements `mulberry32`; `rng.ts:12-13` has the "test-only seeded rng. ignore" dismissal. `config.ts:224-226` parses `ACQUIRER_RNG_SEED` with no `nodeEnv` guard, and `simulator.ts:85` swaps the RNG when it's set. The unseeded default is crypto (`simulator.ts:1,23`), and `acquirerReference` still uses `randomUUID` (`:132`).

**Contradicts:** `rng.ts:13` ("test-only seeded rng. ignore").

**Why it matters:** a production env var can silently make approve/decline/error outcomes deterministic and predictable. It's not a loss-of-funds bug (the acquirer is simulated), but the "ignore" framing hides a real reachable path.

**Priority:** P2.

### Finding 30: Simulator idempotency caches are unbounded and keyed by key alone

**Evidence:** `simulator.ts:93-95` creates three maps, never swept or bounded; `simulator.ts:82-83` argues "cleared on restart... not a leak". Lookups key on `idempotencyKey` only (`:122,141,157`), so two different authorize requests sharing a key return the first result silently.

**Contradicts:** `simulator.ts:83` ("cleared on restart and we deploy daily. not a leak").

**Why it matters:** memory grows with unique keys for the process lifetime, and the simulator teaches the wrong idempotency semantics (real gateways reject key reuse with a different payload).

**Priority:** P2.

### Finding 31: Outbound signatures cover canonical JSON, not the bytes sent

**Evidence:** `sign.ts:36-37` signs `${timestamp}.${canonicalJson(payload)}`. `dispatcher.ts:172` sends `JSON.stringify(row.payload)` in insertion order, which differs byte-for-byte whenever keys aren't sorted. `dispatcher.test.ts:129` admits the test re-canonicalizes before verifying, so it can't catch a byte mismatch.

**Contradicts:** `CHANGELOG.md:27` ("sign the exact bytes sent"); commit `e0ddf3b` isn't an ancestor.

**Why it matters:** a receiver following the normal raw-body HMAC pattern will never verify. Only receivers that parse and re-canonicalize work, and nothing documents that.

**Priority:** P2.

### Finding 32: Replay mints a new `delivery_event_id`

**Evidence:** `replay.ts:46-49` generates `randomUUID()` and rewrites the body `id`. That id is both the body dedupe key (envelope.ts:12-13) and the `Webhook-Delivery-Id` header (`dispatcher.ts:169`). The stability contract rests on `headers.ts:10-13` ("must be stable across retries AND replays"), `0022_webhook_deliveries.sql:43-44` ("replay must reuse delivery_event_id") and `adminMerchants.ts:211` ("replay keeps the original id"). `docs/ARCHITECTURE.md:63-65` only says every delivery "carries a `Webhook-Delivery-Id`"; it never explicitly asserts replay stability. The rebuttal at `0022:45-46` says receivers dedupe on the outbox event, but no outbox id is ever transmitted.

**Contradicts:** `adminMerchants.ts:211`, `headers.ts:12`, `0022:43-44`; `docs/ARCHITECTURE.md:63-65` only states the header is carried. Overlap: `lane-webhooks-core` F-5 and `lane-webhooks-lifecycle` F-2, same defect with complementary citations.

**Why it matters:** a receiver that dedupes on the documented id processes a replay a second time, duplicating merchant side effects.

**Priority:** P2.

### Finding 33: Refund state keeps `partially_captured` after a full refund of a partial capture

**Evidence:** `refundState.ts:16-18` promises "never left in a capture status once its full captured amount has been returned", but `:47-48` short-circuits to `partially_captured` when captured is below authorized, before considering refunds. `refundState.ts:30-31` quotes the finance rule it doesn't follow. The comment at `refundState.test.ts:59` ("wrote these from the spec in ARCHITECTURE.md, don't edit without asking MK") cites a spec that doesn't exist: `rg -i refund docs/ARCHITECTURE.md` returns nothing.

**Contradicts:** its own docstring at `refundState.ts:16-18`, the finance rule quoted at `refundState.ts:30-31`, and the attributed ARCHITECTURE.md spec (the comment citing it is at `refundState.test.ts:59`; no such spec exists — `rg -i refund docs/ARCHITECTURE.md` returns nothing).

**Why it matters:** statuses stop meaning what they say, the row stays open for re-capture, and "refunded" is unreachable for partial captures. Fix Finding 4 first, or statuses get computed on over-refunded totals.

**Priority:** P2.

### Finding 34: `POST /v1/refunds` is still a 501 stub

**Evidence:** `routes/refunds.ts:22-24` returns 501. `routes/refunds.ts:9` says it's a stub until refunds land. The wiring commit `5fe1d4a` is not an ancestor and exists only on two remote branches. `docs/HANDOVER.md:12` correctly says 501; `:17` says wired.

**Contradicts:** `CHANGELOG.md:21-22`, `docs/HANDOVER.md:17`.

**Why it matters:** the refund feature is unreachable end to end, which is also the only thing currently containing Findings 4, 5, 8, 9 and 10. Wiring before those are fixed turns latent defects into live money movement.

**Priority:** P1 sequencing gate, not a code fix.

### Finding 35: `expire_holds.ts` deletes hold history, including a race window

**Evidence:** `scripts/expire_holds.ts:29-37` and `scripts/lib/sqlFilter.ts:24-30` build `DELETE FROM holds WHERE id = ANY(...)`, with no status or expiry guard in the DELETE. `expire_holds.ts:42` acknowledges a hold captured between SELECT and DELETE is still deleted. `db/migrations/0005_holds.sql:21-23` agrees with deletion.

**Contradicts:** `payments/authorize.ts:113-114` ("it never deletes, so the hold history stays") and `expire_holds.ts:30` docstring ("still active").

**Why it matters:** the authorization audit trail disappears, and a successfully captured or voided hold can lose its release record in the race.

**Priority:** P2.

### Finding 36: The acquirer idempotency key embeds `attemptCount`

**Evidence:** `capture.ts:173-179` and `authorize.ts:94-100` build `${claim.row.id}:${claim.row.attemptCount}`. `idempotency.ts:156-163` increments the attempt on retry. `simulator.ts:87-92` documents that the same key returns the cached result, which the API can never exercise.

**Contradicts:** `simulator.ts:87-92` (same key returns the cached result) and the retry-safety intent in `capture.ts:173-179` and `authorize.ts:94-100`.

**Why it matters:** against a real acquirer, a retry after an ambiguous timeout is a brand-new request. A committed-but-unacknowledged authorization can become two holds or two chargeable auths.

**Priority:** P2.

### Finding 37: The committed backoff test is effectively red, and the cap is soft

**Evidence:** `dispatcher.ts:53-60` jitters by plus or minus 10 percent using `Math.random` by default. `dispatcher.test.ts:195-196` asserts exactly 1000, and `:215-216` asserts exactly 2000. The probability of both passing is roughly 0.001 percent per run, and no stub exists. The cap is applied before jitter (`:60`), so the actual delay can exceed `webhookBackoffCapMs` by up to 10 percent, contradicting `config.ts:104-105`.

**Contradicts:** `config.ts:104-105` ("no retry ever waits longer than this") and the test's own expectation of un-jittered values.

**Why it matters:** a red suite hides real regressions in the same file, and the retry cap isn't hard. See the test-lock exception in Scope guardrails: this test must be corrected, which conflicts with the blanket "tests are regression-locked" rule and needs owner sign-off.

**Priority:** P1 (it blocks trustworthy verification for every webhook fix).

### Finding 38: Simulator decline/error branches and the magic-PAN claim are untested

**Evidence:** `simulator.test.ts:27-31` claims magic PANs are deterministic "regardless of the failure-rate roll" but configures `acquirerFailureRate: 0`, so the test can't distinguish magic precedence from a roll that never declines. No test asserts a rolled `"error"`, a rolled decline's `declineReason`, or capture/refund decline or error (`simulator.test.ts:63-67,88-96`). `simulator.ts:104-108,140-155` contain those branches, and capture/refund drop `declineReason` entirely (`types.ts:42-46,54-58`).

**Contradicts:** the test title at `simulator.test.ts:27` ("deterministic regardless of the failure-rate roll"), which the test as written cannot prove.

**Why it matters:** a regression in the decline-reason selection or error branch passes the suite.

**Priority:** P2.

### Finding 39: Simulator result types don't model a real acquirer

**Evidence:** `types.ts:3-9` declares fee, ledger, settlement and status out of scope. `types.ts:28-31` carries only outcome, an opaque reference, an optional decline reason and latency. `simulator.ts:149,164` echoes the caller's `acquirerReference` for capture and refund. `simulator.ts:125-130` validates nothing (no positive amount, no capture ceiling).

**Contradicts:** nothing. `types.ts:3-9` honestly declares out of scope. The problem is framing, not a false claim.

**Why it matters:** migrating to a real acquirer means replacing the interface, not extending it. Approval codes, response codes, reversal and per-merchant acquirer config are absent. Treat it as a demo seam.

**Priority:** P2, mostly a documentation and naming decision.

### Finding 40: Negative or fractional `amountFils` becomes a 500

**Evidence:** `routes/transactions.ts:79,103` call `toFils` with no body schema. `packages/money/src/fils.ts:33-41` throws `RangeError`, which `plugins/errorHandler.ts:30-35` doesn't map, so it becomes `500 internal_error`.

**Contradicts:** the API boundary's own 4xx contract; no explicit doc claim exists, but `errorHandler.ts` is built to avoid 500s for client errors.

**Why it matters:** client input pollutes error-rate monitoring and hides a boundary validation gap.

**Priority:** P3.

### Finding 41: Dead `v1/routes/transactions.ts` contains an unauthenticated capture handler

**Evidence:** `apps/api/src/v1/routes/transactions.ts:16-44` registers `POST /:id/capture` with no preHandler, no merchant predicate (`:29-31`), no idempotency, and no writes. Tree-wide search finds no import or registration. `app.ts:58` confirms the tree is dead.

**Contradicts:** nothing functional today. `app.ts:58` correctly calls the tree dead, and the file's own warning at `v1/routes/transactions.ts:14-15` is accurate.

**Why it matters:** a future import or "port the old capture" refactor would expose capture. Nothing flags the file.

**Priority:** P3.

### Finding 42: Test send ignores endpoint status

**Evidence:** `testSend.ts:40` selects `status` but never reads it; `:48-64` signs and POSTs regardless. Replay enforces active (`replay.ts:106-108`), and Step A only creates for active endpoints.

**Contradicts:** the disabled-endpoint semantics documented at `cancel.ts:8-10` and `update.ts:23-28`, and the replay gate at `replay.ts:106-108`.

**Why it matters:** a disabled or decommissioned endpoint keeps receiving traffic from test send, inconsistent with replay and dispatch.

**Priority:** P3.

### Finding 43: `secretCrypto.ts` docblock claims deterministic encryption

**Evidence:** `secretCrypto.ts:29` says "Deterministic ... so stored ciphertexts can be compared for equality", immediately above `:32`'s fresh random IV per call. The encryption itself is correct AES-256-GCM.

**Contradicts:** the docblock immediately above the code (`secretCrypto.ts:29` versus `:32`).

**Why it matters:** anyone building equality or rotation checks on `secret_ciphertext` writes logic that can never match.

**Priority:** P3 (comment only).

### Finding 44: Batch replay accepts `status=succeeded` despite the comment

**Evidence:** `replayBatch.ts:19-20` says the route rejects `succeeded`; `:78-84` accepts any status in the array. `routes/adminMerchants.ts:221-235` validates only non-empty, with default `["exhausted"]` at `:243`. `replay.ts:22-26` discusses `delivery_event_id` freshness and minting, not replay statuses, so it neither supports nor contradicts `replayBatch.ts:20` on that point.

**Contradicts:** `replayBatch.ts:20` ("the route rejects succeeded"). The code accepts any status in the array regardless.

**Why it matters:** operators are told a control exists that doesn't. Any admin session can re-send already succeeded deliveries.

**Priority:** P3.

### Finding 45: `parsePromotionalDiscountFils` uses `parseFloat` and `*100`

**Evidence:** `payments/discountAdjustment.ts:12-17` does `parseFloat(raw)` and `Math.round(parsed * 100)`. `AGENTS.md:49-52` requires `parseBhdToFils` for all parsing, implemented at `packages/money/src/fils.ts:282-291`.

**Contradicts:** `AGENTS.md:49-52` (use `parseBhdToFils` for all amount parsing, never `parseFloat`).

**Why it matters:** BHD is 3-decimal, so a 2-decimal float path misrounds at the fils boundary. A one-fils-off discount shifts fee and refund math for that transaction.

**Priority:** P3. Note it isn't on the capture path.

### Finding 46: `docs/README.md` points at a key that isn't in `ops/.env.docker`

**Evidence:** `docs/README.md:112` says the sandbox key is "in ops/.env.docker". The file contains `NODE_ENV`, `PORT` and `ACQUIRER_CALLBACK_SIGNING_SECRET` only.

**Contradicts:** `docs/README.md:112` itself.

**Why it matters:** the documented setup dead-ends, and the API won't boot without a valid 32-byte key (Finding 24).

**Priority:** P3.

### Finding 47: The "flaky" note on a deterministic simulator test is baseless

**Evidence:** `simulator.test.ts:123-150` seeds both simulators identically (`acquirerRngSeed: 777`), calls in the same order with the same keys, and strips the only crypto value (`acquirerReference`) before comparing. The comment at `:123` says "flaky once on my machine, couldnt repro".

**Contradicts:** nothing in the code. The test is structurally deterministic; the note is unsupported.

**Why it matters:** it's the shape of a planted note meant to make a reviewer distrust and disable a good regression test. No code change is required beyond deleting the note.

**Priority:** P3.

---

## Implementation plan

No code is written here. Each entry says how a fixer lane should do it, which files change, what proves it, and what can go wrong. Order within a tier is the recommended landing order. The tiers are gates, not dates.

### Sequencing decision before the tiers

**`refund.succeeded` consumption (Finding 1, priority P1).** Decide first, because the answer changes the order of every refund-related fix: ship it, or suppress the producer. Recommended: ship it, because refunds already produce the event. Sequence matters. Add the `refund.succeeded` variant to `WebhookEventType` and a `buildEnvelope` case in `apps/api/src/webhooks/envelope.ts` (payload shape: refund id, amount, fee reversed, refunded total, status). Only then add it to `WEBHOOK_ELIGIBLE_EVENT_TYPES` in `apps/api/src/webhooks/dispatcher.ts`. Then add it to `REPORTING_EVENT_TYPES` in `apps/reporting/src/consumer/runConsumerPass.ts` and the rollup in `apps/reporting/src/consumer/applyEvent.ts`, with the refund columns migration if not present. If the decision is "not yet", remove the enqueue at `processRefund.ts:246` or mark the type known-unconsumed and add an outbox age alert. Files: `envelope.ts`, `dispatcher.ts`, `runConsumerPass.ts`, `applyEvent.ts`, `processRefund.ts`, `AGENTS.md`, `CHANGELOG.md`, `docs/HANDOVER.md`. Verify: envelope test, dispatcher test, reporting consumer test, plus a one-off check that a refund outbox row gets a delivery. Risk: adding eligibility before the envelope case stalls Step A for every merchant (documented at `dispatcher.ts:26`). Tests for this may exist under other names; search before adding.

### Tier P0: before any hosted demo or real acquirer

**2. Callback signature enforcement (Finding 2).** Make enforcement follow configuration presence, not a separate default-false flag. In `apps/api/src/config.ts`, default `acquirerCallbackRequireSignature` to `nodeEnv === "production"`, or derive it from a non-empty secret. Add the explicit `true` to `ops/.env.docker` once Finding 25 makes that file actually load. Delete the unsigned-acceptance test at `routes/acquirerCallbacks.test.ts:124-131` and replace it with a production-mode test asserting 401. Files: `config.ts`, `ops/.env.docker`, the route test. Verify: run the route test and `inboundVerify.test.ts`. Risk: the existing test is regression-locked by repo policy, so this requires explicit owner approval (see Scope guardrails). Without that approval, this finding cannot be fixed.

**3. Rotate the committed acquirer secret (Finding 3).** Treat `acqsec_sandbox_f8c3a1e6b9d24f7081c5e3a9b7d4f602` as compromised. Generate a new secret, deliver it out of band, add `ops/.env.docker` to `.gitignore`, commit an `ops/.env.docker.example` with placeholders, and purge the value from history if the repo will be public (history rewrite needs owner sign-off and coordination with every clone). Files: `.gitignore`, `ops/.env.docker`, `ops/.env.docker.example`, the fork-publication checklist. Verify: `git ls-files ops/.env.docker` returns nothing; a grep for the old value returns nothing. Risk: history rewrite breaks clones and open PRs; do it once, coordinated, or accept the exposure and rotate only.

**4. Refund ceiling on captured funds (Finding 4).** Change `processRefund.ts:90` to `subtractFils(capturedFils, refundedFils)`. Update `refundableAmount` and its docstring in `refundValidation.ts`, and correct the two mislabeled tests at `refundValidation.test.ts:55,73`. Files: `processRefund.ts`, `refundValidation.ts`, the two tests. Verify: `processRefund.test.ts`, `refundValidation.test.ts`, plus a new assertion for a partial capture refunded up to captured only. Risk: status semantics change for partial captures, so pair with Finding 33.

**5. Lock the refund transaction (Finding 5).** Restructure `processRefund` into one `withTransaction` that claims the idempotency key, locks the transaction row with `SELECT ... FOR UPDATE` scoped by merchant, validates against the locked copy, calls the acquirer while holding the lock, and journals before commit. This is the shape `capture.ts` uses. Add a regression test with two concurrent refunds on one transaction and different keys, asserting exactly one succeeds. Files: `processRefund.ts`, `idempotency.ts` usage, `processRefund.test.ts`. Verify: `processRefund.test.ts` and `initiateMerchantRefund.test.ts`; the concurrency test must not depend on sleep timing, so drive both calls and await both, then assert row counts. Risk: holding a row lock across an HTTP call increases lock wait under load. Bound it with the acquirer timeout and document the trade-off; the alternative (reserve the amount first, then call) is safer at scale and is the better long-term design.

**6. Capture idempotency scope (Finding 6).** Either include `transactionId` in the capture request hash, or scope the endpoint as `transactions.capture:<transactionId>`, or both. On replay, compare the stored `resource_id` to the requested transaction and return 422 `idempotency_key_reused` on mismatch. Files: `capture.ts`, `idempotency.ts` (replay metadata), `routes/transactions.ts`. Verify: `idempotency.test.ts`, `routes/transactions.test.ts`, plus the missing case: same key and body on a different transaction must be 422, never a replay. Risk: changing the hash invalidates stored idempotency rows for in-flight clients. Acceptable for a hackathon tree; double-check no long-lived keys.

**7. Role gates and impersonation (Finding 7).** Chain `requireMerchantRole("owner")` (or the product-approved owner plus finance set) on capture and void. Make `requireMerchantWriterActor` reject `admin_impersonation`. Record the impersonating admin id from the auth context in `transaction_events.metadata`. Files: `routes/transactions.ts`, `auth/requireMerchantAuth.ts`, `admin/impersonation.ts` comment. Verify: `routes/transactions.test.ts` and a new test that a support session gets 403 and an impersonation grant gets 403. Risk: tightening roles can break the demo script if it uses a support session; check the seeded demo accounts first.

**8. Refund ownership check (Finding 8).** Add `AND merchant_id = $2` to the lookup in `initiateMerchantRefund.ts:63-66`, or compare after the read and throw `NotFoundError("transaction_not_found")`. Run the hold check against the owning merchant. Files: `initiateMerchantRefund.ts`. Verify: `initiateMerchantRefund.test.ts` plus the TODO at `:170` (cross-merchant id must 404). Risk: low.

**9. Net fee reversal (Finding 9).** Change the fee read to `SUM(CASE WHEN direction='credit' THEN amount_fils ELSE -amount_fils END)` over `platform_fee_revenue`, excluding rows whose description marks a prior refund reversal. Files: `processRefund.ts`. Verify: `processRefund.test.ts` plus a discounted-merchant refund test asserting the reversal equals the net share. Risk: the description string is a fragile key; prefer a typed ledger reason column if one exists, otherwise keep the filter narrow and documented.

**10. Refund reason durable (Finding 10).** Insert `input.reason ?? "unspecified"`, or omit the column so the migration default applies. Hash the same effective value at `processRefund.ts:48`. Files: `processRefund.ts`. Verify: `processRefund.test.ts` with a no-reason refund against a migrated database. Risk: low, but the insert must be validated before the acquirer call so no other NOT NULL column can fail post-refund.

**11. Callback freshness (Finding 11).** After MAC verification, enforce an absolute tolerance window against the server clock, mirroring `sign.ts` (verify MAC first so the window isn't an oracle). Return 401 with a distinct reason. Files: `inboundVerify.ts`, `routes/acquirerCallbacks.ts`. Verify: `inboundVerify.test.ts` and `routes/acquirerCallbacks.test.ts`; add a stale timestamp case. Risk: clock skew with a real acquirer; use a documented symmetric window and log rejections.

**12. Callback dedupe (Finding 12).** Add migration `0073` with a unique index on `(transaction_id, callback_id)`, change the insert to `ON CONFLICT (transaction_id, callback_id) DO NOTHING`, and return whether a row was inserted. The route can then return 200 with `duplicate: true`, or the existing shape. Files: `db/migrations/0073_*.sql`, `acquirer/callbacks.ts`, `routes/acquirerCallbacks.ts`. Verify: `acquirer/callbacks.test.ts`, `routes/acquirerCallbacks.test.ts`, plus "same signed body twice produces one note" and a concurrent duplicate test. Risk: pre-existing duplicate rows will block index creation; dedupe them in the migration first.

**13. Callback outcome validation (Finding 13).** Validate against `"cleared" | "confirmed_fraud"` at the route and return 400. Add a DB check in the new migration. Fix the comment at `routes/acquirerCallbacks.ts:10-12`. Files: route, `db/migrations/0073_*.sql`. Verify: route test for a non-union outcome and a valid one. Risk: if the real acquirer sends different strings, validation will reject live traffic. Confirm against the integration guide or accept both aliases explicitly, not implicitly.

### Tier P1: before merchant-facing launch

**14. `occurredAt` handling (Finding 14).** Validate ISO-8601 at the route, store `received_at = now()`, and add an `occurred_at` column for the acquirer's timestamp. Files: route, `acquirer/callbacks.ts`, migration. Verify: route tests for malformed, epoch and offset inputs. Risk: existing rows need a backfill decision.

**15. Constant-time compare (Finding 15).** Replace `constantTimeEquals` with `timingSafeEqualHex` from `lib/crypto.ts`, keeping the length pre-check. Files: `inboundVerify.ts`. Verify: `inboundVerify.test.ts`. Risk: none.

**16. Raw-body signing (Finding 16).** Capture the raw request bytes before parsing (Fastify content-type parser or `rawBody` hook) and verify the HMAC over them. If the acquirer actually signs canonical JSON, document that contract and test the exact bytes on the wire instead. Files: `inboundVerify.ts`, route, `app.ts`. Verify: `inboundVerify.test.ts`, route test signing exact bytes, plus a key-order variation case. Risk: changes the contract; coordinate with whoever owns the acquirer integration.

**19. Daily volume rollup (Finding 19).** Call `recordCaptureMetric` inside the capture transaction, using the same client so it commits atomically. If the rollup is meant to come from the outbox, delete the dead function instead and document the rebuild dependency. Files: `capture.ts`, possibly `admin/reportingRebuild.ts` docs. Verify: `routes/transactions.test.ts` plus an assertion that `merchant_daily_volume` changes after capture, and `routes/analytics.test.ts`. Risk: adding work under the capture lock; measure before shipping.

**20. LISTEN reconnect (Finding 20).** Implement the reconnect described in the incident doc: on `error` or `end`, tear down the client and schedule `startListening` at the poll cadence with a single timer, and have `stop()` clear it. Files: `dispatcher.ts`. Verify: `dispatcher.test.ts` with a fake client that emits an error and a test that only one timer is live. Risk: double timers on flapping connections; guard explicitly.

**21. Step B row claim (Finding 21).** Add `FOR UPDATE SKIP LOCKED` to the due-row SELECT, or an atomic claim UPDATE to `in_flight` returning the rows. Make the terminal UPDATE conditional on the expected attempt count. Files: `dispatcher.ts`, possibly a status value migration. Verify: `dispatcher.test.ts` plus a test that two concurrent passes deliver each row once. Risk: `in_flight` rows need crash recovery (timeout back to pending); without it a crash loses work.

**22. Disbursement dedupe (Finding 22).** Add `UNIQUE (settlement_batch_id)` (or a scoped unique key) and `ON CONFLICT DO NOTHING`, skip the effect for replay rows, and gate it on the first attempt across endpoints. Long term, move the record to the payout path and make the webhook path read-only. Files: `payoutDisbursement.ts`, `dispatcher.ts`, new migration, `payoutDisbursement.test.ts`. Verify: `payoutDisbursement.test.ts` and a dispatcher test with two endpoints and a replay producing one row. Risk: existing duplicates block the unique index; dedupe in the migration.

**23. Endpoint deletion policy (Finding 23).** Pick one: `ON DELETE SET NULL` with snapshotted URL and merchant, soft delete, or archive then cascade. Whichever it is, implement it in a migration plus code, map FK errors to 409 if any remain, and add a test deleting an endpoint with deliveries. Files: `cancel.ts`, new migration, `routes/webhooks.test.ts`. Verify: route test and a direct DB assertion that delivery history survives. Risk: audit retention is a compliance decision; don't pick silently.

**24. Dev key (Finding 24).** Replace the fallback with a valid 32-byte value, or delete the fallback and require the env var. Update `ops/README.md` and the compose comment. Files: `config.ts`, `ops/README.md`, `ops/docker-compose.yml`. Verify: boot the API with no key in dev and with a bad key in prod, asserting the documented outcomes. Risk: a real dev key in source is fine only if it is clearly non-production.

**25. Compose env file (Finding 25).** Add `env_file: ops/.env.docker` to each service, or use `--env-file` with interpolation, and fix the docs. Files: `ops/docker-compose.yml`, `ops/README.md`. Verify: `docker compose config` shows the variables inside the api service. Risk: compose path resolution is relative to the compose file; use a path that works from the documented working directory.

**26. Production secrets in compose (Finding 26).** Supply `WEBHOOK_SECRET_ENCRYPTION_KEY` and `SETTLEMENT_INTERNAL_TOKEN`, or stop setting `NODE_ENV=production` in the default dev compose. Update the required-settings table. Files: `ops/.env.docker`, `ops/docker-compose.yml`, `ops/README.md`. Verify: `docker compose up` reaches a listening API. Risk: don't commit real production secrets; use generated values for the sandbox.

**27. SSRF controls (Finding 27).** Resolve the host at create, update and request time; reject loopback, link-local including metadata, RFC1918 and ULA ranges. Set `redirect: "manual"` and re-validate each hop, or refuse redirects. Reduce or remove the response-body echo. Apply the same checks to test send and to delivery. Files: `webhooks/create.ts`, `webhooks/transport.ts`, `webhooks/testSend.ts`, `webhooks/dispatcher.ts`, `routes/webhooks.ts`. Verify: `webhooks.test.ts` and `testSend.test.ts` with localhost, 169.254.169.254, a redirect and a hostname that resolves privately. Risk: DNS rebinding needs resolve-and-pin, not just a check; and dev localhost receivers need an explicit non-production exception or they break.

**28. Poison-row state machine (Finding 28).** On a thrown row error, increment `attempt_count` and schedule `next_attempt_at` with backoff, or quarantine the row, so it can't stay at the head. Add key-version support so rotation doesn't poison everything at once, and alert on pending rows far in the past and on repeated decrypt failures. Files: `dispatcher.ts`, `secretCrypto.ts`, migration for key version, metrics. Verify: `dispatcher.test.ts` with a decrypt-failing row followed by healthy rows, asserting healthy ones still deliver and the poison row backs off. Risk: quarantining hides real failures; pair with the alert.

**34. Wire the refund route (Finding 34).** Only after Findings 4, 5, 8, 9, 10. Replace the 501 with a handler that requires a client idempotency key, never generates one server-side, and calls `initiateMerchantRefund`. Update the 501 assertions in `routes/transactions.test.ts`. Files: `routes/refunds.ts`, route tests, API docs. Verify: `routes/transactions.test.ts`, `initiateMerchantRefund.test.ts`, `processRefund.test.ts`, plus an end-to-end refund that produces a webhook and reporting row. Risk: premature wiring turns every latent refund defect live. This is a sequencing gate first.

**37. Backoff test and hard cap (Finding 37).** This lands early in P1 because every webhook fix depends on a trustworthy suite. Make jitter injectable and pass a fixed source in the test, or assert a range. Apply jitter before the cap so the cap is hard, and align the config docstring. Files: `dispatcher.ts`, `dispatcher.test.ts`, `config.ts`. Verify: `dispatcher.test.ts` in a single run, repeated ten times to prove determinism. Risk: editing a regression-locked test needs owner approval.

### Tier P2: next hardening pass

**17. Callback retry policy (Finding 17).** Retry only transient database errors, pass `NotFoundError` through immediately, and use exponential backoff with jitter. Files: `acquirer/callbacks.ts`. Verify: `acquirer/callbacks.test.ts` asserting one attempt for 404 and three for a connection failure. Risk: low.

**18. Simulator callback producer (Finding 18).** Add a simulator method or scripted gateway test that signs and posts a real callback payload through the HTTP surface. Keep it test-only or dev-only. Files: `acquirer/simulator.ts` or a new test helper, plus an integration test. Verify: the integration test must go through `app.inject` with a real signature. Risk: scope creep; keep it a test helper unless the demo needs it.

**29. Seed guard (Finding 29).** Reject `ACQUIRER_RNG_SEED` when `nodeEnv === "production"`, or warn loudly and ignore it. Replace the "ignore" comment with the real behavior. Files: `config.ts`, `rng.ts`. Verify: a config test asserting production rejection. Risk: a demo may rely on the seed; provide an explicit test-only path.

**30. Simulator caches (Finding 30).** Bound the maps (LRU or max size) and key by key plus a request fingerprint, returning a conflict when the same key carries a different payload. Files: `simulator.ts`, `types.ts`, `simulator.test.ts`. Verify: a test for same key and different payload. Risk: simulator-only semantics; don't over-invest.

**31. Outbound byte signing (Finding 31).** Sign the exact body string that transport sends, and document raw-body verification for receivers, or keep canonical signing and document re-canonicalization. Add a test that the signed string equals the wire body when raw signing is chosen. Files: `sign.ts`, `dispatcher.ts`, `docs` for receivers. Verify: `sign.test.ts`, `dispatcher.test.ts`. Risk: changing the scheme breaks existing receivers; version the signature or keep both.

**32. Replay id contract (Finding 32).** Choose one contract and make comments match. Reuse the original `delivery_event_id` for replays (the partial unique index allows it because replay rows are excluded), or keep a new id and add an explicit `replay-of` header plus a stable body id. Consider rejecting replay of succeeded rows to the same endpoint. Files: `replay.ts`, `headers.ts`, `adminMerchants.ts` comment, `0022` comment (new migration comment, not editing the old migration). Verify: `routes/webhooks.test.ts` replay test and `archiveReplay.test.ts`. Risk: receivers may already treat replays as new events; announce the contract.

**33. Refund status rule (Finding 33).** After Finding 4, decide whether full return of captured funds sets `refunded` regardless of authorization headroom. If yes, implement and gate re-capture on `refunded_fils < captured_fils`. If no, delete the false docstring and state the headroom-kept-open rule. Files: `refundState.ts`, `refundState.test.ts`. Verify: `refundState.test.ts` and `processRefund.test.ts`. Risk: downstream code assumes `partially_captured` means open to capture; audit before changing.

**35. Hold expiry (Finding 35).** Replace select-then-delete with one guarded statement: `DELETE FROM holds WHERE status = 'active' AND expires_at < now()` (self-contained), or switch to `UPDATE ... SET status = 'expired'` and keep rows. Align the contradictory comments. Files: `scripts/expire_holds.ts`, `scripts/lib/sqlFilter.ts`, `authorize.ts` comment, `0005` note via new migration comment. Verify: a script test that a hold released between selection and deletion is not deleted. Risk: if any consumer needs hold rows, deletion must become an update.

**36. Stable acquirer key (Finding 36).** Use `${claim.row.id}` alone, or a merchant plus logical-request identity, rather than the attempt-scoped composite. Document why if per-attempt keys were intentional. Files: `capture.ts`, `authorize.ts`. Verify: `idempotency.test.ts` and a unit test asserting the key passed to the acquirer is identical across retries. Risk: the simulator's caches become reachable, which is the point.

**38. Simulator test coverage (Finding 38).** Add tests at a high failure rate for rolled decline and error, assert `declineReason` presence and absence, exercise capture and refund decline/error, and rerun the magic-PAN assertions at `acquirerFailureRate: 1` so precedence is proven. Decide whether capture/refund can express decline reasons. Files: `simulator.test.ts`, `types.ts` if the model changes. Verify: `simulator.test.ts`. Risk: test-only, but repo test-lock policy requires owner approval to modify.

**39. Simulator contract framing (Finding 39).** Either widen the types toward a real acquirer (approval code, response codes, reversal, validation) or rename and document the simulator as a demo and load-test seam. Files: `types.ts`, `simulator.ts`, docs. Verify: typecheck plus the simulator tests. Risk: widening without callers adds unused surface.

### Tier P3: cleanup

**40. Amount validation (Finding 40).** Add body schemas with `integer` and `minimum: 1` for authorize and capture, or map `RangeError` to 422. Files: `routes/transactions.ts`. Verify: `routes/transactions.test.ts` with fractional and negative amounts returning 4xx. Risk: none.

**41. Dead v1 tree (Finding 41).** Delete `apps/api/src/v1/routes/transactions.ts` and its directory, or exclude it from the build and assert its route never registers. Files: that file, build config. Verify: typecheck and a route-list test. Risk: something may import it outside the search scope; confirm before deleting.

**42. Test send status gate (Finding 42).** Reject non-active endpoints with `ConflictError("endpoint_disabled")`, matching replay. Files: `testSend.ts`. Verify: `testSend.test.ts` asserting 409 and that the transport is never called. Risk: none.

**43. Secret crypto comment (Finding 43).** Replace the docblock with an accurate statement: random IV per call, never compare ciphertexts. Files: `secretCrypto.ts`. Verify: no test needed (prose only). Risk: none.

**44. Replay batch statuses (Finding 44).** Either enforce the claimed rejection or gate succeeded behind a stronger admin role, and align the comments. Files: `replayBatch.ts`, `routes/adminMerchants.ts`. Verify: `routes/admin.test.ts` or the admin route tests for a succeeded replay. Risk: operators may rely on replaying succeeded rows; confirm first.

**45. Discount parsing (Finding 45).** Replace with `parseBhdToFils` and map `RangeError` to `BadRequestError("invalid_discount")`. Files: `discountAdjustment.ts`, `discountAdjustment.test.ts`. Verify: that test with 3-decimal and boundary values. Risk: none.

**46. README key pointer (Finding 46).** Point at the real location or remove the pointer, and fix the related boot-path docs. Files: `docs/README.md`, `ops/README.md`. Verify: follow the README on a clean shell until the API answers. Risk: none.

**47. Flaky note (Finding 47).** Delete the unsubstantiated comment. Files: `simulator.test.ts` (owner approval under the test-lock rule). Verify: none required. Risk: none.

---

## Verification commands

Prerequisites, once per shell:

```bash
cd /home/burglar/Work/Source/fils-pay
export DATABASE_URL=postgres://.../filspay   # a real, migrated database
bun run migrate                              # required by DB-backed tests
```

API dependency install and baseline, before touching anything:

```bash
bun install
(cd apps/api && bun run typecheck)
(cd apps/api && bun run test)                # full api suite; expect the known red backoff test (Finding 37)
```

Targeted runs. The api package uses `tsx --test`, so file paths are passed to it directly. Use one command per finding group.

```bash
# Findings 1, 31, 32, 37 (outbound webhooks)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/envelope.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/dispatcher.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/sign.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/routes/webhooks.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/archiveReplay.test.ts)

# Findings 2, 11 to 18, 40 (callbacks and the inbound verifier)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/inboundVerify.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/routes/acquirerCallbacks.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/acquirer/callbacks.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/acquirer/simulator.test.ts)

# Findings 4 to 10, 33, 34, 45 (refunds and capture)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/payments/processRefund.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/payments/refundValidation.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/payments/refundState.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/refunds/initiateMerchantRefund.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/payments/idempotency.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/routes/transactions.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/payments/discountAdjustment.test.ts)

# Findings 6, 7, 19, 40 (payment lifecycle and analytics)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/routes/transactions.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/routes/analytics.test.ts)

# Findings 22, 23, 25 to 28, 42, 44 (webhooks lifecycle, ops, transport)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/testSend.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/payoutDisbursement.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/routes/webhooks.test.ts)
(cd apps/api && bunx tsx --test --test-concurrency=1 src/webhooks/secretCrypto.test.ts)

# Findings 24 to 26, 46 (config and compose)
(cd apps/api && bun run typecheck)
(cd ops && docker compose config)            # inspect resolved environment
```

Settlement and repository-wide gates, per `AGENTS.md` (run after every change):

```bash
cd /home/burglar/Work/Source/fils-pay
bun test
(cd apps/settlement && go test ./...)
```

Migration check after adding 0073 or a disbursement unique index:

```bash
bun run migrate
psql "$DATABASE_URL" -c "\d acquirer_callback_notes"
psql "$DATABASE_URL" -c "\d webhook_deliveries"
psql "$DATABASE_URL" -c "\d settlement_payout_disbursements"
```

Test-lock warning: `AGENTS.md` says test files are regression-locked. Findings 2, 37, 38 and 47 cannot be fixed honestly without changing a test. In those cases the locked test asserts the defect or is nondeterministic, and the owner must approve the change explicitly. Do not "fix" them by weakening assertions, and do not mark a test skipped to go green.

---

## Scope guardrails

Read these before touching anything. They come from `AGENTS.md`, `docs/ARCHITECTURE.md`, and the ADRs under `docs/adr/`.

1. **Never modify `packages/money/`.** Frozen after the Q2 audit; changes require finance approval and re-certification (`AGENTS.md`, "Do not modify"). This includes `packages/money/src/fils.ts`, the canonical `toFils`, `applyRateFils`, `parseBhdToFils` and `calculateRefundFee`. Fixing Findings 9 and 45 must happen in `apps/api`, calling the existing helpers, not by editing them.

2. **Never modify `apps/settlement/internal/money/`.** It's the Go mirror of the frozen TypeScript package, under the same freeze. No finding in this document requires it.

3. **Test files are regression-locked.** `*.test.ts` and `*_test.go` assert current correct behavior; the default rule is that a failing test means the change is wrong (`AGENTS.md`). The narrow exceptions are Findings 2, 37, 38 and 47, where the test asserts a defect or is nondeterministic. Even there, land the change only with explicit owner approval, and never by deleting, skipping or loosening a test to pass.

4. **The `v1/` API surface stays.** The `v1/` prefix in route files is the live partner API, and 501 endpoints are reserved stubs that must not be removed or modified (`AGENTS.md`, "API"). Concretely: `apps/api/src/routes/refunds.ts` stays a 501 stub until the P0 refund fixes land and the owner approves wiring (Finding 34). The *dead* `apps/api/src/v1/routes/transactions.ts` is different: it is not registered, it's flagged dead at `app.ts:58`, and Finding 41 proposes deleting it, which needs owner sign-off since it sits under a `v1/` path.

5. **`refund.succeeded` handling follows one truth, not one comment.** `AGENTS.md` says the type is intentionally absent from `WEBHOOK_ELIGIBLE_EVENT_TYPES`; that matches the code today. It does not license leaving the producer writing undeliverable rows. Any change must update `AGENTS.md`, `CHANGELOG.md` and `docs/HANDOVER.md` in the same change so the three stop disagreeing.

6. **ADR commitments are not in scope to reverse.** See `docs/adr/0001-integer-fils.md` (integer fils everywhere), `0002-scheme-residue-at-export.md` (truncation to 10 fils at export), `0003-report-date-windows.md`, `0004-balance-rebuild-source.md` (ledger is the source of truth), `0005-settlement-v2-shadow-ledger.md`, and `0006-display-adjustments.md`. None of the fixes here should alter money representation, rounding, or report windows. If a fix seems to require one, stop and escalate.

7. **Do not change monetary column types or rounding.** `AGENTS.md` states monetary columns are `INTEGER`, while the transaction money columns are `BIGINT` (`db/migrations/0004_transactions.sql:13-15`). That contradiction is not this plan's business, and neither is a type change: widening or narrowing needs a DBA-approved migration plan. Findings 4, 9 and 40 are about ceilings and parsing in `apps/api`, not column types or rounding.

8. **No secret goes into the repo.** The fix for Finding 3 is rotation plus ignoring the env file, not committing a new secret. `ops/.env.docker.example` holds placeholders only.

9. **Docs are claims, not proof.** This repository's comments and docs have repeatedly asserted fixes that aren't in the tree (Findings 1, 12, 20, 23, 24, 25, 31, 32, 43). Every fixer lane should verify against code and a test run, then update the doc in the same change, rather than trusting a comment's "done" or a commit hash that isn't an ancestor of HEAD.

---

*Prepared as a plan only. No source file, migration, test or ops file was modified in producing it.*
