# Plan: webhook subsystem audit and fix

> Placement note: lives at `docs/plans/` per the planning-lane contract. This is the
> how-we-will-do-it document for the whole webhook subsystem: inbound acquirer callbacks,
> outbound merchant deliveries, and the admin replay/archive/support surfaces. It changes
> no code itself. An implementing lane applies it step by step.
>
> Evidence base: four read-only audit reports dated 2026-10-30, listed in section 0.
> Every anchor below was re-read against the working tree during this planning pass unless
> the section says otherwise. Where an audit anchor did not match the tree, the corrected
> anchor is used and the mismatch is called out in section 4.

| | |
|---|---|
| **Author** | AI planning lane (webhook subsystem) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY. No source file is touched by this document. |
| **Decision** | Treat the code as the source of truth. Fix the three headline defects first (inbound signature enforcement, outbound signing over the wrong bytes, callback dedup), then the operational gaps (LISTEN reconnect, delete 409, SSRF, retention), then the support surfaces (test-send button, admin archive screens, delivery detail view). Keep the locked test files and the frozen money packages untouched. |

**Evidence base.**

- `/tmp/ulw-webhooks-RfFL8W/waves/webhooks-audit/inbound.md` (inbound acquirer callbacks)
- `/tmp/ulw-webhooks-RfFL8W/waves/webhooks-audit/outbound.md` (outbound merchant deliveries)
- `/tmp/ulw-webhooks-RfFL8W/waves/webhooks-audit/support.md` (replay, archive, test-send, delivery log, UIs)
- `/tmp/ulw-webhooks-RfFL8W/waves/webhooks-audit/tests.md` (test inventory and the runtime result)

Those paths live outside the repo and may be cleaned up. The findings they carry are
restated here with repo anchors so this plan stands alone.

---

## 1. What the webhooks are for

FilsPay has three separate webhook surfaces. They look similar in code because two of them
share the `t=...,v1=...` HMAC header shape. They serve different purposes and have
different trust models.

### 1.1 Inbound acquirer callbacks

The card processor sometimes finishes a fraud-review verdict after the synchronous
authorize/capture/refund call has already returned. It posts that verdict back to FilsPay at
`POST /v1/acquirer/callbacks`. The platform's only job is to authenticate the caller, then
append one informational note to the transaction's timeline for support and finance. It is
not a payment state change and it never touches the ledger.

There is one platform-level shared secret for this relationship
(`apps/api/src/config.ts:114-118`), not one secret per merchant. The route is registered with
no auth preHandler at `apps/api/src/app.ts:72`; the signature is the only authentication.

Nothing inside this repo posts to the endpoint. The acquirer simulator does not sign or send
callbacks, and the seed never writes `acquirer_callback_notes` — the only INSERT into that
table is `applyAcquirerCallback` (`apps/api/src/acquirer/callbacks.ts:38`);
`db/seed/generate.ts:860` only reads the table in a `NOT EXISTS` guard. The surface is
dormant unless an external acquirer or a manual `curl` exercises it.

### 1.2 Outbound merchant webhooks

Merchants register HTTP endpoints and receive signed transaction and settlement events.
The pipeline has four stages:

1. **Outbox.** The business transaction writes an `outbox_events` row in the same database
   transaction as the business change (`packages/events/src/outbox.ts:83-95`). Nothing is
   sent from inside that transaction.
2. **Delivery creation (Step A).** The dispatcher turns each eligible `(outbox row, active
   endpoint)` pair into a durable `webhook_deliveries` row with a public envelope body
   (`apps/api/src/webhooks/dispatcher.ts:88-114`).
3. **Delivery attempt (Step B).** A background dispatcher picks due pending rows, decrypts
   the endpoint secret, signs, POSTs, and records the outcome with exponential backoff
   (`apps/api/src/webhooks/dispatcher.ts:150-213`).
4. **Wakeups.** A Postgres trigger calls `pg_notify` on every outbox insert
   (`db/migrations/0021_webhook_endpoints.sql:24-37`). The dispatcher LISTENs on that
   channel and also runs a poll timer, default every five seconds
   (`apps/api/src/webhooks/dispatcher.ts:323`; `apps/api/src/config.ts:255`).

Each delivery carries `Webhook-Signature` and `Webhook-Delivery-Id`
(`apps/api/src/webhooks/headers.ts:8-14`). The delivery id is the receiver's dedup key.

### 1.3 Admin replay, archive, and support tooling

The support surface exists so operators can recover from delivery failures without touching
the database.

- **Single replay (merchant plane).** Requeue one previously attempted delivery as a new
  pending row for the same endpoint (`apps/api/src/webhooks/replay.ts:38-62`).
- **Batch replay (admin plane).** Requeue every delivery for one endpoint inside a date
  range, filtered by status, capped at 500 rows (`apps/api/src/webhooks/replayBatch.ts:62-95`).
- **Archive and restore (admin plane).** Snapshot an endpoint's delivery history before a
  URL rotation or a disable, then bulk-replay that snapshot against the old or a replacement
  endpoint (`apps/api/src/webhooks/archiveReplay.ts:30-94` and `:117-166`).
- **Test-send.** Synchronously POST a synthetic `test.ping` and return the receiver's actual
  response so a merchant sees reachability immediately
  (`apps/api/src/webhooks/testSend.ts:46-71`).
- **Delivery log.** Cursor-paginated list plus a detail view that includes payload and
  signature (`apps/api/src/routes/webhooks.ts:180-182`, `:216-218`).

All replay paths only insert pending rows. The actual HTTP send always happens later in the
normal dispatcher pass.

---

## 2. Do they work

### 2.1 Verdict table

| # | Subsystem | Verdict | Evidence |
|---|---|---|---|
| I1 | Inbound endpoint wiring and required-field check | WORKS | `apps/api/src/app.ts:72`; `apps/api/src/routes/acquirerCallbacks.ts:41-55` |
| I2 | Inbound HMAC algorithm (`t=...,v1=...`, HMAC-SHA256) | WORKS | `apps/api/src/webhooks/inboundVerify.ts:56-64` |
| I3 | Inbound signature enforcement in the shipped environment | BROKEN | `apps/api/src/config.ts:259` defaults false; `ops/.env.docker` never sets the flag; `ops/docker-compose.yml:69-89` has no `env_file` |
| I4 | Inbound freshness window (replay protection) | BROKEN | `apps/api/src/webhooks/inboundVerify.ts:32`, `:52-64` parse `t` but never compare it with a clock |
| I5 | Inbound dedup on `(transaction_id, callback_id)` | BROKEN | `db/migrations/0051_acquirer_callback_notes.sql:14-27` has no unique constraint; `apps/api/src/acquirer/callbacks.ts:37-50` is a plain INSERT |
| I6 | Inbound `outcome` validation | BROKEN | `apps/api/src/routes/acquirerCallbacks.ts:44-49` checks truthiness only; `:72` is a TypeScript cast; the real union is `cleared`/`confirmed_fraud` (`apps/api/src/acquirer/callbacks.ts:10`) |
| I7 | Inbound `occurredAt` validation | BROKEN | `apps/api/src/routes/acquirerCallbacks.ts:47`; the value is inserted as `received_at` (`apps/api/src/acquirer/callbacks.ts:48`) and a malformed value becomes a 500 (`apps/api/src/plugins/errorHandler.ts:33-35`) |
| I8 | Inbound verify over raw bytes and constant-time compare | PART-IMPLEMENTED | `apps/api/src/webhooks/inboundVerify.ts:40-43` uses `Buffer.compare`; `:61-63` HMACs `JSON.stringify(parsedBody)` |
| I9 | Inbound authentication ordering | PART-IMPLEMENTED | body check at `apps/api/src/routes/acquirerCallbacks.ts:43-55` runs before signature verification at `:57-64` |
| I10 | Inbound producer inside the repo | STUB | no caller of the route exists; the simulator sends nothing and the seed never writes the notes table (only INSERT is `apps/api/src/acquirer/callbacks.ts:38`; `db/seed/generate.ts:860` is a read guard) |
| O1 | Transactional outbox enqueue | WORKS | `packages/events/src/outbox.ts:77-95` |
| O2 | Step A delivery creation and concurrency guard | WORKS | `apps/api/src/webhooks/dispatcher.ts:88-114`, `:112-122`; `db/migrations/0022_webhook_deliveries.sql:39-42` |
| O3 | NOTIFY trigger, LISTEN handler, poll fallback | PART-IMPLEMENTED | trigger `db/migrations/0021_webhook_endpoints.sql:24-37`; LISTEN `apps/api/src/webhooks/dispatcher.ts:299-320`; poll `:323`; no reconnect on error at `:303-305` |
| O4 | Step B at-least-once retry and backoff | WORKS (single replica) | `apps/api/src/webhooks/dispatcher.ts:150-213` |
| O5 | Outbound signature over the bytes actually sent | BROKEN | signs canonical JSON at `apps/api/src/webhooks/sign.ts:31-42`, sends `JSON.stringify` at `apps/api/src/webhooks/dispatcher.ts:158` and `:172`; same defect in `apps/api/src/webhooks/testSend.ts:56-63` |
| O6 | Delivery headers | WORKS | `apps/api/src/webhooks/headers.ts:8-14`; set per delivery at `apps/api/src/webhooks/dispatcher.ts:168-171` |
| O7 | Secret generation and encryption at rest | WORKS | `apps/api/src/webhooks/create.ts:60`; `apps/api/src/webhooks/secretCrypto.ts:30-38` |
| O8 | Secret rotation | STUB | no rotate route; `apps/api/src/webhooks/update.ts:23-26` deliberately does not rotate |
| O9 | Endpoint CRUD routes and auth | WORKS | `apps/api/src/routes/webhooks.ts:56-58`, `:88-90`, `:102-106`, `:120-122`, `:147-158`, `:163-165` |
| O10 | Delete an endpoint that has deliveries | BROKEN | FK with no delete action at `db/migrations/0022_webhook_deliveries.sql:5`; plain DELETE at `apps/api/src/webhooks/cancel.ts:21-26`; comments claim a cascade that no migration adds (`apps/api/src/webhooks/cancel.ts:15-16`, `apps/api/src/routes/webhooks.ts:102-103`) |
| O11 | `refund.succeeded` merchant delivery | BROKEN (absent) | eligibility list `apps/api/src/webhooks/dispatcher.ts:28-32`; envelope union `apps/api/src/webhooks/envelope.ts:9`; event is enqueued at `apps/api/src/payments/processRefund.ts:243-246` |
| O12 | SSRF posture on outbound URL and redirects | PART-IMPLEMENTED | scheme-only check `apps/api/src/webhooks/create.ts:15-31`; redirect-following transport `apps/api/src/webhooks/transport.ts:38-52` |
| O13 | Multi-replica delivery safety | PART-IMPLEMENTED | no `FOR UPDATE SKIP LOCKED` at `apps/api/src/webhooks/dispatcher.ts:222-231`; single-replica assumption at `apps/api/src/index.ts:29-31` |
| O14 | Poisoned delivery rows | PART-IMPLEMENTED | pre-transport failure leaves `next_attempt_at` untouched and re-runs every poll tick (`apps/api/src/webhooks/dispatcher.ts:231-246`) |
| S1 | Single replay (merchant) | WORKS | `apps/api/src/webhooks/replay.ts:38-62`; route `apps/api/src/routes/webhooks.ts:163-165` |
| S2 | Batch replay (admin) | WORKS with gaps | `apps/api/src/routes/adminMerchants.ts:212-245`; `apps/api/src/webhooks/replayBatch.ts:62-95` |
| S3 | Batch replay status validation | PART-IMPLEMENTED | only "non-empty array" is checked at `apps/api/src/routes/adminMerchants.ts:230-235`; the comment at `apps/api/src/webhooks/replayBatch.ts:19-20` claims the route rejects `succeeded`, which it does not |
| S4 | Delivery id stability across replays | PART-IMPLEMENTED | public contract at `apps/api/src/webhooks/headers.ts:10-12` and `apps/api/src/webhooks/envelope.ts:12`; code mints a new id at `apps/api/src/webhooks/replay.ts:48-49`, and the locked test asserts exactly that |
| S5 | Archive create and restore (API) | PART-IMPLEMENTED | `apps/api/src/webhooks/archiveReplay.ts:30-94`, `:117-166`; no UI anywhere |
| S6 | Archive paging and compression | BROKEN (as documented) | single unbounded SELECT and `JSON.stringify` at `apps/api/src/webhooks/archiveReplay.ts:45-52`, `:63-75`; claims of paging/compression at `apps/api/src/routes/adminMerchants.ts:53-56`, `docs/ADMIN.md:103-107`, `db/migrations/0068_webhook_delivery_archives.sql:35-37` |
| S7 | Archive retention | STUB | `pruneExpiredArchives` defined at `apps/api/src/webhooks/archiveReplay.ts:100-113` and called by nothing |
| S8 | Test-send | PART-IMPLEMENTED | API `apps/api/src/webhooks/testSend.ts:46-71`; no UI button on `apps/web/src/pages/webhooks/WebhookEndpointDetailPage.tsx:217-228` |
| S9 | Delivery log (list and detail API) | WORKS | `apps/api/src/routes/webhooks.ts:180-182`, `:216-218` |
| S10 | Merchant web UI | WORKS | list/create/detail pages map to real routes; detail page offers replay only |
| S11 | Admin web UI | PART-IMPLEMENTED | only `WebhookReplayPage` exists (`apps/admin/src/router.tsx:31-32`) |

### 2.2 What the table means in one paragraph per subsystem

**Inbound is wired and mechanically correct, but insecure as shipped.** The endpoint exists,
the HMAC math is right, and the note append is harmless by design. Everything around that
core is missing: signatures are optional because the shipped environment never turns them on
(I3), replayed signed callbacks are accepted forever (I4), duplicate redeliveries create
duplicate notes (I5), and neither `outcome` nor `occurredAt` is validated (I6, I7). The
default posture also accepts a request with no signature header while rejecting a request
with a wrong one, so the weakest caller passes and the merely mistaken one fails.

**Outbound delivers at least once, but no real receiver can verify what it receives.** The
durable pipeline, retries, backoff, headers, and secret encryption are sound. The signature
covers a canonical re-serialization while the wire body is a different serialization, so a
receiver computing the HMAC over the bytes it got fails every time (O5). The in-repo tests
cannot see this because they re-canonicalize the parsed body before verifying. On top of
that, refund events are enqueued and never delivered (O11), a dropped LISTEN connection is
never re-established (O3), and the URL validation is scheme-only (O12).

**Support tooling is real but under-surfaced.** Replay, archive, restore, test-send, and the
delivery log all exist and mostly work. What is missing is operator access (no UI for
archive, restore, test-send, or delivery detail), retention (dead code), a delete path that
returns something other than a 500, and any validation on replay-batch statuses.

---

## 3. Implementation plan

### Ground rules for the implementing lane

1. **Never edit `packages/money/` or `apps/settlement/internal/money/`.** Both are frozen.
   Nothing in this plan needs them.
2. **Never edit an existing test file.** Tests are regression-locked. Several of them pin the
   exact behavior this plan changes around (the unsigned-callback test, the new-id-on-replay
   assertion, the poisoned-row attempt count). New coverage goes in **new** test files with
   new names, for example `apps/api/src/webhooks/delivery-bytes.test.ts`. If a step's change
   makes a locked test fail, stop and reconsider the step, do not edit the test.
3. **Re-run `git status --short` before every step.** Other agents work in this repo at the
   same time. If a file this step names has moved or already changed, read it again before
   editing and reconcile with what is on disk.
4. Steps are ordered so the high-severity fixes land before the operational polish. Each
   step is one atomic task and names its own verification command.
5. Every DB-backed verification needs a migrated Postgres. Run `bun run migrate` first and
   export `DATABASE_URL`. The audit machine had no Postgres, so the audit's `bun test` run
   could not reach those assertions; that is an environment gap, not a code failure.

### Phase A: inbound acquirer callbacks

#### Step 1. Turn signature enforcement on in the shipped environment

**Files:** `ops/.env.docker`, `ops/docker-compose.yml`.

**Change:**
- Add one line to `ops/.env.docker`: `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true`.
- Under the `api` service in `ops/docker-compose.yml` (around lines 69-89), add
  `env_file: [./.env.docker]`. Compose already auto-loads a file named `.env`, not
  `.env.docker`, which is why the flag and even `NODE_ENV` never reach the container.
- Do **not** change the default in `apps/api/src/config.ts:259`. The locked route test
  explicitly accepts an unsigned callback (`apps/api/src/routes/acquirerCallbacks.test.ts:124-140`),
  so flipping the default would break a regression-locked file.

**Expected:** the API container boots with `acquirerCallbackRequireSignature === true`, and
`NODE_ENV=production` now also reaches the process. A request with no signature header is
rejected with 401 `invalid_signature`.

**Verify:**

```bash
cd ops && docker compose config | grep -A2 'env_file'
grep -n 'ACQUIRER_CALLBACK_REQUIRE_SIGNATURE' .env.docker
cd .. && NODE_ENV=production DATABASE_URL=postgres://x SETTLEMENT_INTERNAL_TOKEN=t \
  ACQUIRER_CALLBACK_SIGNING_SECRET=s ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true \
  WEBHOOK_SECRET_ENCRYPTION_KEY=Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk= \
  bun -e 'import { loadConfig } from "./apps/api/src/config.ts"; console.log(loadConfig(process.env).acquirerCallbackRequireSignature)'
```

Expected: `env_file` present, the grep finds the line, and the probe prints `true`.

#### Step 2. Authenticate first, then validate `outcome` and `occurredAt`

**Files:** `apps/api/src/routes/acquirerCallbacks.ts`.

**Change:**
1. Move the signature verification block (currently `:57-64`) above the required-field
   check (currently `:43-55`). Authentication runs before any request-shape feedback.
2. Replace the truthiness check for `outcome` with an enum check against the real union,
   `"cleared"` and `"confirmed_fraud"` (`apps/api/src/acquirer/callbacks.ts:10`). Reject
   anything else with 400 `invalid_request`.
3. Parse `occurredAt` with `new Date(...)` and reject `NaN` with 400 `invalid_request`
   before the database call. This replaces the implicit Postgres cast failure that today
   surfaces as a 500 through `apps/api/src/plugins/errorHandler.ts:33-35`.
4. Delete or correct the false docblock at `:9-12` (it names `"approved"`/`"rejected"` and
   claims a validation that does not exist).

**Expected:** a correctly signed callback with `"outcome": "banana"` returns 400
`invalid_request`. A correctly signed callback with `"occurredAt": "2026-99-99"` returns 400
`invalid_request`. A valid callback still returns 200 and writes one note. No retry loop
runs for malformed input.

**Verify:** with the API running and `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true`:

```bash
body='{"callbackId":"cb-audit-1","type":"fraud_review.completed","transactionId":"<real-tx-id>","occurredAt":"2026-99-99","outcome":"cleared","note":"x"}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$ACQUIRER_CALLBACK_SIGNING_SECRET" | awk '{print $2}')
curl -sS -o /tmp/cb.json -w '%{http_code}\n' -X POST http://127.0.0.1:3000/v1/acquirer/callbacks \
  -H 'content-type: application/json' -H "acquirer-callback-signature: t=$ts,v1=$sig" -d "$body"
cat /tmp/cb.json
```

Expected: `400` and `{"error":"invalid_request",...}`. Repeat with a valid ISO timestamp and
`"outcome":"banana"`, expect `400`. Repeat with both valid, expect `200 {"received":true}`.

#### Step 3. Deduplicate callbacks on `(transaction_id, callback_id)`

**Files:** new `db/migrations/0073_acquirer_callback_dedup.sql`,
`apps/api/src/acquirer/callbacks.ts`.

**Change:**
1. New migration: `CREATE UNIQUE INDEX uq_acquirer_callback_notes_tx_callback ON
   acquirer_callback_notes (transaction_id, callback_id);`. The highest existing migration is
   `db/migrations/0072_refund_merchant_summary.sql`, so `0073` is the next free number. The comment in
   `db/migrations/0051_acquirer_callback_notes.sql:29-32` claiming `0073` already exists is
   false; that is the number this step takes.
2. In `applyAcquirerCallback` (`apps/api/src/acquirer/callbacks.ts:27-51`), change the plain
   INSERT to `ON CONFLICT (transaction_id, callback_id) DO NOTHING RETURNING id`. Return a
   `duplicate: true` flag when no row came back.
3. In the route, keep returning 200 `{received:true}` and add `duplicate:true` for a
   redelivery. Do not turn a duplicate into a 4xx; acquirers retry on non-2xx.

**Expected:** posting the same signed callback twice writes one note and answers 200 both
times, the second with `duplicate:true`. Two different `callbackId` values for the same
transaction still produce two notes.

**Verify:**

```bash
bun run migrate
psql "$DATABASE_URL" -c '\d acquirer_callback_notes' | grep -i uq_acquirer_callback_notes_tx_callback
# post the same body from step 2 twice, both signed with fresh timestamps
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM acquirer_callback_notes WHERE callback_id='cb-audit-1'"
```

Expected: the unique index is listed, and the count is `1`.

#### Step 4. Sign over the raw request bytes and reuse the shared constant-time compare

**Files:** `apps/api/src/routes/acquirerCallbacks.ts`, `apps/api/src/webhooks/inboundVerify.ts`,
`apps/api/src/fastify-instance.d.ts`.

**Change:**
1. Capture the raw body for this plugin only. Add a `preParsing` hook inside
   `acquirerCallbackRoutes` that buffers the stream up to a bounded size (1 MB is enough for
   this payload), stores it on the request as `rawBody: Buffer`, and returns a new readable
   stream with the same bytes so Fastify's JSON parser still runs. Declare `rawBody` on an
   `interface FastifyRequest` augmentation in `apps/api/src/fastify-instance.d.ts` (the file
   currently augments `FastifyInstance` only).
2. Change `verifyAcquirerCallbackSignature` to take `rawBody: string` instead of the parsed
   `payload`, and HMAC `` `${parsed.timestamp}.${rawBody}` `` at
   `apps/api/src/webhooks/inboundVerify.ts:61-63`.
3. Replace the private `constantTimeEquals` (`:40-43`) with `timingSafeEqualHex` from
   `apps/api/src/lib/crypto.ts:14-21`, which is the same helper the outbound verifier uses.
4. If the raw body cannot be captured (missing hook, streaming failure), reject with 401
   `malformed_header` rather than falling back to re-serialization.

**Expected:** a callback whose JSON keys are in a different order than the server would
re-serialize still verifies, because the HMAC is over the exact bytes on the wire. A single
mutated byte fails. The compare no longer short-circuits on the first differing byte.

**Verify:**

```bash
body='{"note":"x","outcome":"cleared","occurredAt":"2026-10-30T10:00:00Z","transactionId":"<real-tx-id>","type":"fraud_review.completed","callbackId":"cb-raw-1"}'
ts=$(date +%s)
sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$ACQUIRER_CALLBACK_SIGNING_SECRET" | awk '{print $2}')
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/v1/acquirer/callbacks \
  -H 'content-type: application/json' -H "acquirer-callback-signature: t=$ts,v1=$sig" -d "$body"
```

Expected: `200`. Then run the same command with one character changed in `-d` but not in the
signed string: expect `401`.

#### Step 5. Enforce a freshness window when signatures are required

**Files:** `apps/api/src/webhooks/inboundVerify.ts`, `apps/api/src/config.ts`,
`apps/api/src/routes/acquirerCallbacks.ts`, `ops/.env.docker`.

**Change:**
1. Add `acquirerCallbackToleranceSeconds` to `Config` (`apps/api/src/config.ts:110-118`
   block) with a default of 300, matching the outbound verifier's default
   (`apps/api/src/webhooks/sign.ts:99-104`).
2. Add `"timestamp_out_of_tolerance"` to `VerifyAcquirerCallbackFailureReason` and check
   `Math.abs(now - parsed.timestamp) > tolerance` **after** the HMAC comparison, exactly the
   order the outbound verifier uses.
3. Enforce the check only when `requireSignature` is true. The locked route test signs with a
   fixed old timestamp (`apps/api/src/routes/acquirerCallbacks.test.ts:62-65`, default
   `1_757_930_000`) and runs with the flag off; gating on the flag keeps that test green while
   the shipped posture from step 1 gets the protection.
4. Pass the tolerance through from the route.

**Expected:** with enforcement on, a correctly signed callback with a one-hour-old `t` is
rejected 401 with `timestamp_out_of_tolerance`. A fresh one succeeds. With enforcement off,
behavior is unchanged.

**Verify:** repeat the step 4 curl with `ts=$(($(date +%s) - 3600))`, expect `401` and
`timestamp_out_of_tolerance`. Then post with `ts=$(date +%s)`, expect `200`. Also run:

```bash
bun test apps/api/src/webhooks/inboundVerify.test.ts
```

Expected: 5 pass, 0 fail (the optional-mode tests are untouched).

### Phase B: outbound merchant deliveries

#### Step 6. Sign and send the same bytes

**Files:** `apps/api/src/webhooks/sign.ts`, `apps/api/src/webhooks/dispatcher.ts`,
`apps/api/src/webhooks/testSend.ts`.

**Change:**
1. Add `signBody(rawBody: string, secret: string, timestamp?: number): SignedPayload` to
   `apps/api/src/webhooks/sign.ts`. It HMACs `` `${timestamp}.${rawBody}` ``. Keep
   `signPayload` as a thin wrapper that calls `signBody(canonicalJson(payload), ...)` so the
   public API and its existing tests do not change.
2. In `attemptOneDelivery` (`apps/api/src/webhooks/dispatcher.ts:150-196`), serialize once:
   `const body = canonicalJson(row.payload)`, sign that string with `signBody`, and send that
   exact `body`. Replace the current `signPayload(row.payload)` at `:158` and
   `JSON.stringify(row.payload)` at `:172`.
3. Do the same in `testSend.ts`: one `const body`, signed with `signBody`, sent unchanged.
   Delete the false comment at `apps/api/src/webhooks/testSend.ts:31`.
4. Keep `verifySignature` as-is for tests and a future merchant tool.

**Expected:** `HMAC-SHA256(secret, t + "." + receivedBody)` equals the `v1` in the header for
every delivery. A receiver that reads the raw body and never re-serializes verifies
successfully.

**Verify:**

```bash
bun -e '
import { signBody } from "./apps/api/src/webhooks/sign.ts";
import { createHmac } from "node:crypto";
const body = JSON.stringify({ id: "x", type: "transaction.captured" });
const { signature } = signBody(body, "k");
const [tPart, v1Part] = signature.split(",");
const expected = createHmac("sha256", "k").update(`${tPart.slice(2)}.${body}`).digest("hex");
console.log("MATCHES", expected === v1Part.slice(3));
'
```

Expected: `MATCHES true`. Then add a new DB-backed test file
`apps/api/src/webhooks/delivery-bytes.test.ts` that starts a local HTTP receiver, computes the
HMAC over `req` raw bytes, and asserts it matches. Run `bun test
apps/api/src/webhooks/delivery-bytes.test.ts` and expect 1 pass.

#### Step 7. Reconnect the LISTEN client

**Files:** `apps/api/src/webhooks/dispatcher.ts`.

**Change:** replace the single-shot connect block (`:299-320`) and the log-only error handler
(`:303-305`) with a reconnect loop. On `error` or `end`, schedule a new `Client`, `connect()`,
`LISTEN` again, and retry at the poll cadence with a capped backoff. A new `stopped` check must
prevent a reconnect during `stop()`. Do not create a timer that outlives `stop()`.

**Expected:** after `pg_terminate_backend` kills the LISTEN session, the process re-establishes
the listener without a restart, logged once. Delivery latency returns to NOTIFY speed instead
of waiting for the poll tick. Data delivery was never at risk because the poll kept working.

**Verify:** with the API running and a log file captured:

```bash
psql "$DATABASE_URL" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN %';"
timeout 30 bash -c 'until grep -q "LISTEN re-established" /tmp/api.log; do sleep 1; done' && echo RECONNECTED
```

Expected: `RECONNECTED` inside the timeout. The new test file
`apps/api/src/webhooks/dispatcher-listen.test.ts` should assert the reconnect with a bounded
wait on the observable connect event, never a fixed sleep.

#### Step 8. Return 409 instead of 500 when an endpoint still has deliveries

**Files:** `apps/api/src/webhooks/cancel.ts`, `apps/api/src/routes/webhooks.ts`.

**Change:** in `deleteWebhookEndpoint`, first count deliveries for the endpoint inside the
same transaction. If the count is nonzero, return a typed outcome (for example
`"has_deliveries"`) and have the route answer 409 `endpoint_has_deliveries` with a message
pointing at the existing `PATCH status=disabled` path (`apps/api/src/webhooks/update.ts:38-53`).
Do not add a cascade: `webhook_delivery_archives` also references `webhook_endpoints`
(`db/migrations/0068_webhook_delivery_archives.sql:15`), and deleting history would defeat
the archive feature.

**Expected:** deleting an endpoint with deliveries answers 409, not 500, and deletes nothing.
Deleting an endpoint with no deliveries still answers 204.

**Verify:** add `apps/api/src/routes/webhook-delete-guard.test.ts` (new file). It registers an
endpoint, inserts one delivery row through the dispatcher or directly, calls `DELETE`, and
asserts 409 `endpoint_has_deliveries`, then deletes an unused endpoint and expects 204. Run
`bun test apps/api/src/routes/webhook-delete-guard.test.ts`. Expected: 2 pass.

#### Step 9. Add webhook secret rotation

**Files:** new `apps/api/src/webhooks/rotateSecret.ts`, `apps/api/src/routes/webhooks.ts`,
`apps/web/src/api/webhooks.ts`.

**Change:**
1. `apps/api/src/webhooks/rotateSecret.ts` mints `whsec_${randomToken(24)}` (same as `apps/api/src/webhooks/create.ts:60`), encrypts it
   with `encryptSecret`, updates `secret_ciphertext` and `secret_prefix`, and returns the
   plaintext secret exactly once.
2. Route: `POST /v1/merchants/:merchantId/webhook-endpoints/:id/rotate-secret`, preHandler
   `requireMerchantAuth` plus `requireMerchantRole("owner", "finance")`, ownership check via
   `assertOwnMerchant`, 404 for a foreign id.
3. Fix the false docblock at `apps/api/src/webhooks/secretCrypto.ts:29`: a random IV per call
   means ciphertexts are not deterministic and cannot be compared for equality.

**Expected:** the response carries a new `whsec_` secret once. The next delivery is signed
with the new secret. The old secret stops working.

**Verify:**

```bash
before=$(psql "$DATABASE_URL" -tAc "SELECT secret_ciphertext FROM webhook_endpoints WHERE id='<endpoint-id>'")
curl -sS -X POST http://127.0.0.1:3000/v1/merchants/<merchant-id>/webhook-endpoints/<endpoint-id>/rotate-secret \
  -H "authorization: Bearer $MERCHANT_TOKEN"
after=$(psql "$DATABASE_URL" -tAc "SELECT secret_ciphertext FROM webhook_endpoints WHERE id='<endpoint-id>'")
[ "$before" != "$after" ] && echo ROTATED
```

Expected: `ROTATED`, and the response JSON has a `secret` field. A second call with a
`support` role token expects 403.

#### Step 10. Close the SSRF gap in URL validation and redirects

**Files:** `apps/api/src/webhooks/create.ts`, `apps/api/src/webhooks/transport.ts`.

**Change:**
1. Extend `validateWebhookUrl` (`apps/api/src/webhooks/create.ts:15-31`). When `nodeEnv === "production"`, resolve
   the hostname and reject localhost names, loopback, link-local, private IPv4 ranges, and
   IPv6 unique-local/loopback addresses. Keep the existing scheme rules. Reject literal
   private IPs even without DNS.
2. Set `redirect: "manual"` in the transport fetch call (`apps/api/src/webhooks/transport.ts:39-52`). A 3xx becomes
   a normal non-2xx outcome the dispatcher already retries, never an internal fetch.
3. Correct the false comments at `apps/api/src/webhooks/transport.ts:38-39`.

**Expected:** in production, `http://127.0.0.1/...` and `https://169.254.169.254/...` are
rejected at registration with 400 `invalid_url`. In development, local receivers still work,
which keeps the locked route tests green (they use `http://127.0.0.1:<port>`). A redirecting
receiver is recorded as a failed attempt, not followed.

**Verify:**

```bash
NODE_ENV=production bun -e '
import { validateWebhookUrl } from "./apps/api/src/webhooks/create.ts";
for (const u of ["http://127.0.0.1/x", "https://169.254.169.254/latest", "https://10.0.0.5/hook"]) {
  try { validateWebhookUrl(u, { nodeEnv: "production" }); console.log("ALLOWED", u); }
  catch { console.log("BLOCKED", u); }
}
'
```

Expected: three `BLOCKED` lines. The same probe with `http://127.0.0.1:3999/hook` and
`{ nodeEnv: "development" }` expects `ALLOWED`.

#### Step 11. Validate replay-batch statuses against the delivery enum

**Files:** `apps/api/src/routes/adminMerchants.ts`.

**Change:** after the non-empty array check (`:230-235`), reject any status outside
`succeeded`, `failed`, `exhausted`, and `pending` with 400 `invalid_request`. These are the
values the `webhook_deliveries.status` CHECK allows
(`db/migrations/0022_webhook_deliveries.sql:12-13`). Fix the false comment at
`apps/api/src/webhooks/replayBatch.ts:19-20`.

**Expected:** `{"statuses":["bogus"]}` returns 400. `{"statuses":["succeeded"]}` returns 200,
because the UI and the handler both treat replaying succeeded rows as a supported action
(`apps/api/src/routes/adminMerchants.ts:206-207`,
`apps/admin/src/pages/webhooks/WebhookReplayPage.tsx:31-36`).

**Verify:**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:3000/v1/admin/merchants/<m>/webhook-endpoints/<e>/replay-batch \
  -H "cookie: $ADMIN_COOKIE" -H 'content-type: application/json' \
  -d '{"from":"2026-01-01T00:00:00Z","to":"2026-10-30T00:00:00Z","statuses":["bogus"]}'
```

Expected: `400`.

#### Step 12. Advance `next_attempt_at` on pre-transport failures

**Files:** `apps/api/src/webhooks/dispatcher.ts`.

**Change:** in the per-row catch at `:231-246`, when the failure happened before a transport
attempt (decrypt error, serialization error), set `next_attempt_at = now() + backoffDelayMs(...)`
without changing `status` or `attempt_count`. Keep the isolation behavior: one bad row must
not abort the pass.

**Expected:** a row with an undecryptable secret stays `pending` with `attempt_count = 0`, but
its `next_attempt_at` moves forward, so it stops re-running every five seconds. The locked
test at `apps/api/src/webhooks/dispatcher.test.ts` asserts `pending` and attempt count, so it
stays green.

**Verify:** add `apps/api/src/webhooks/poisoned-row-backoff.test.ts` (new file). Insert a
delivery whose secret cannot decrypt, run two passes, and assert the second run did not
attempt it and that `next_attempt_at` moved. Run
`bun test apps/api/src/webhooks/poisoned-row-backoff.test.ts`. Expected: 1 pass.

#### Step 13. Wire archive retention

**Files:** `apps/api/src/routes/adminMerchants.ts`.

**Change:** add `POST /v1/admin/webhook-archives/prune` with `requireAdminSession`, body
`{ retentionDays?: number }`, default 365, calling `pruneExpiredArchives`
(`apps/api/src/webhooks/archiveReplay.ts:100-113`). Return `{ deletedCount }`. Document the
route in `docs/RUNBOOK.md` as a daily cron call.

**Expected:** the function gains a production caller. A dry database returns
`{"deletedCount":0}`. An archive older than the cutoff is deleted; a newer one is kept.

**Verify:**

```bash
curl -sS -X POST http://127.0.0.1:3000/v1/admin/webhook-archives/prune \
  -H "cookie: $ADMIN_COOKIE" -H 'content-type: application/json' -d '{"retentionDays":365}'
psql "$DATABASE_URL" -tAc "SELECT count(*) FROM webhook_delivery_archives WHERE created_at < now() - interval '365 days'"
```

Expected: `{"deletedCount":N}` and then `0`.

#### Step 14. GATED: deliver `refund.succeeded`

**Files:** `apps/api/src/webhooks/dispatcher.ts`, `apps/api/src/webhooks/envelope.ts`.

**Gate:** `AGENTS.md:59-61` says refund webhooks are intentionally deferred to v1.9. The
outbound audit argues that reasoning is stale because refunds exist and `processRefund.ts`
already enqueues the event. The two readings disagree, so this step needs an explicit owner
decision before it is applied. If the answer is "not yet", skip the step and leave
`AGENTS.md` alone.

**Change (only if approved):**
1. Add `"refund.succeeded"` to `WEBHOOK_ELIGIBLE_EVENT_TYPES`
   (`apps/api/src/webhooks/dispatcher.ts:28-32`).
2. Add it to `WebhookEventType` (`apps/api/src/webhooks/envelope.ts:9`) and add a case in
   `buildEnvelope`. Map the outbox payload from `apps/api/src/payments/processRefund.ts:243-246` to a public shape:
   `transactionId` from `aggregateId`, plus `merchantId`, `refundId`, `amountFils`,
   `feeReversedFils`, `refundedTotalFils`, and `status` from `newStatus`.
3. Do not edit locked tests. Add `apps/api/src/webhooks/refund-delivery.test.ts` (new file)
   for the positive case.

**Expected:** a refund writes one delivery row and one HTTP POST. The event stops sitting in
the outbox forever.

**Verify:**

```bash
bun test apps/api/src/webhooks/refund-delivery.test.ts
bun test apps/api/src/webhooks/envelope.test.ts
```

Expected: the new test passes, and the two existing envelope tests still pass (the
`settlement.batch_closed` rejection is unchanged).

### Phase C: support surfaces

#### Step 15. Add test-send to the merchant dashboard

**Files:** `apps/web/src/api/webhooks.ts`,
`apps/web/src/pages/webhooks/WebhookEndpointDetailPage.tsx`.

**Change:** add a `testWebhookEndpoint(merchantId, id, message?)` wrapper for
`POST /v1/merchants/:merchantId/webhook-endpoints/:id/test`
(`apps/api/src/routes/webhooks.ts:147-158`). Add a "Send test event" button next to "Replay"
in the endpoint header, show `statusCode` and the body excerpt inline, and keep the existing
role gate (owner/finance) consistent with the server.

**Expected:** the button posts synchronously and shows the receiver's real status and body.
No new server route is needed; the API already exists and is unit tested.

**Verify:**

```bash
cd apps/web && bun run typecheck
```

Expected: exit 0. Then load the detail page, click the button against a local receiver, and
confirm the response panel shows the status code.

#### Step 16. Add archive create and restore screens to the admin console

**Files:** `apps/admin/src/api/webhooks.ts`,
`apps/admin/src/pages/webhooks/WebhookReplayPage.tsx` or a new
`apps/admin/src/pages/webhooks/WebhookArchivePage.tsx`, `apps/admin/src/router.tsx`.

**Change:** add wrappers for
`POST /v1/admin/merchants/:id/webhook-endpoints/:e/archive` and
`POST /v1/admin/merchants/:id/webhook-endpoints/:e/archive/:a/replay`
(`apps/api/src/routes/adminMerchants.ts:256-258`, `:297-299`), plus a screen with a date
range, the resulting archive id, and a restore target endpoint id. Register the route beside
`/webhooks` in `apps/admin/src/router.tsx:31-32`.

**Expected:** an operator can archive a range and restore it without curl. The screen does
not invent server behavior; both routes already exist and are unit tested.

**Verify:**

```bash
cd apps/admin && bun run typecheck
```

Expected: exit 0, then archive a seeded endpoint's range through the UI and confirm the new
archive row in `webhook_delivery_archives`.

#### Step 17. Add a single-delivery detail view

**Files:** `apps/web/src/api/webhooks.ts`,
`apps/web/src/pages/webhooks/WebhookEndpointDetailPage.tsx`.

**Change:** add a `getDelivery(merchantId, endpointId, deliveryId)` wrapper for
`GET .../deliveries/:deliveryId` (`apps/api/src/routes/webhooks.ts:216-218`). Open a detail
panel from the delivery row that shows `payload` and `signature` alongside the response
status and excerpt. The list endpoint deliberately redacts both
(`apps/web/src/api/webhooks.ts:76-79` explains why no wrapper exists today).

**Expected:** support can inspect the exact envelope and signature for one delivery. List
responses still contain no payload.

**Verify:**

```bash
cd apps/web && bun run typecheck
bun test apps/api/src/routes/webhooks.test.ts
```

Expected: typecheck exit 0 and the locked route suite unchanged (it needs a migrated
Postgres). Do not edit that test file.

### Phase D: documentation truth-up

#### Step 18. Correct the documents that contradict the code

**Files:** `CHANGELOG.md`, `docs/HANDOVER.md`, `docs/EXPLANATIONS.md`,
`docs/ADMIN.md`, `docs/archive/audit-bugs-2026-10-30.md`, `docs/plans/completion-batching-2026-10-30.md`.
Do **not** edit the frozen plan documents named in the project agreements; add a superseding
note instead if one of them must change.

**Change:** apply the rulings in section 4:
- Replay ids: the code mints a new `delivery_event_id` and the locked test asserts it
  (`apps/web/src/api/webhooks.ts` replay comment, `apps/api/src/webhooks/replay.ts:48-49`).
  Correct `docs/ADMIN.md:92`, `docs/EXPLANATIONS.md:249`, and the "stable across replays"
  claim in `apps/api/src/webhooks/headers.ts:12`.
- Archives: correct the paging/compression claims in `docs/ADMIN.md:103-107` and the two code
  comments. The schema comment at
  `db/migrations/0068_webhook_delivery_archives.sql:30-34` says the uncapped capture is
  deliberate for compliance. Keep that design and document the memory cost.
- Inbound claims: mark the dedup, validation, and shipped-env statements as fixed only after
  steps 1 to 5 land, with the migration number and endpoint behavior stated.

**Expected:** no doc claims a behavior the code does not have. `grep` for the old phrases
returns only the corrected text.

**Verify:**

```bash
grep -rn "reuses the original delivery ids\|pages of 1000 deliveries\|stored compressed" docs/ || true
grep -rn "sign the exact bytes sent" CHANGELOG.md || true
```

Expected: no stale claim remains, or any remaining hit is a line that says the claim was
wrong.

---

## 4. Doc-vs-code contradictions found, with the ruling

The rule throughout: **the code on disk wins**, and where a regression-locked test pins the
code's behavior, the test wins over both. Each row says what the plan changes as a result.

| # | Document claim | Code reality | Ruling |
|---|---|---|---|
| C1 | `CHANGELOG.md:52-53`, `:92`, `:129-130`, `docs/EXPLANATIONS.md:229-233`, `docs/archive/audit-bugs-2026-10-30.md:48`, `docs/plans/completion-batching-2026-10-30.md:66`: callback notes are deduped, with a `0073` migration and `ON CONFLICT DO NOTHING` | No unique constraint (`db/migrations/0051_acquirer_callback_notes.sql:14-27`), plain INSERT (`apps/api/src/acquirer/callbacks.ts:37-50`), and migration `0073` does not exist (the tree ends at `db/migrations/0072_refund_merchant_summary.sql`) | Code wins. Step 3 creates the index and the conflict clause. The docs become true only when it lands. |
| C2 | `CHANGELOG.md:53`, `docs/EXPLANATIONS.md:232-233`, `docs/bugs/H-12.md`: the shipped env sets `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE=true` | `apps/api/src/config.ts:259` defaults false, `ops/.env.docker` has no such line, and `ops/docker-compose.yml:69-89` never loads that file | Code wins. Step 1 sets the flag and wires `env_file`. H-12's "what is wrong" section is accurate; its shipped-env sentence is not. |
| C3 | `CHANGELOG.md:53`, `docs/EXPLANATIONS.md:231-232`, route docblock `apps/api/src/routes/acquirerCallbacks.ts:9-12`: outcome and `occurredAt` are validated, and the enum is `approved`/`rejected` | Truthiness check only (`:44-49`), a cast (`:72`), no date parse, real union `cleared`/`confirmed_fraud` (`apps/api/src/acquirer/callbacks.ts:10`) | Code wins. Step 2 adds both validations and fixes the docblock. |
| C4 | `CHANGELOG.md:27-28`, `apps/api/src/webhooks/testSend.ts:31`, `packages/events/src/outbox.ts:92`: the signature covers the exact bytes sent | `apps/api/src/webhooks/sign.ts:31-42` signs canonical JSON; `apps/api/src/webhooks/dispatcher.ts:158` and `:172` sign one serialization and send another | Code wins. Step 6 fixes the signer and both call sites. |
| C5 | `CHANGELOG.md:27-28` and `docs/incidents/dispatcher-listen-drop-2026-10-30.md:38-41`: the LISTEN client reconnects, fixed in `a808bf7` | No reconnect in `apps/api/src/webhooks/dispatcher.ts:299-320`; `git merge-base --is-ancestor a808bf7 HEAD` exits 1 on this tree | Code wins. Step 7 implements the reconnect. The incident's "Resolved" status is wrong for main. |
| C6 | `CHANGELOG.md:24` and `docs/HANDOVER.md:17-18`: the `refund.succeeded` webhook shipped | Absent from `apps/api/src/webhooks/dispatcher.ts:28-32` and `apps/api/src/webhooks/envelope.ts:9`; the event is enqueued at `apps/api/src/payments/processRefund.ts:243-246` and never delivered | Code wins today. `AGENTS.md:59-61` is factually right about the list. Step 14 is gated on an owner decision before the list changes. |
| C7 | `apps/api/src/routes/webhooks.ts:102-103` and `apps/api/src/webhooks/cancel.ts:15-16`: the FK cascades or is `SET NULL`, so delete is fine | `db/migrations/0022_webhook_deliveries.sql:5` has no delete action, and no migration alters it; `0047` is `merchant_discount_bps.sql` | Code wins. Step 8 returns 409 and keeps history. A cascade would also strand archives. |
| C8 | `apps/api/src/webhooks/headers.ts:10-12`, `docs/ADMIN.md:92`, `docs/EXPLANATIONS.md:249`: the delivery id is stable across replays and receivers dedupe on it | `apps/api/src/webhooks/replay.ts:48-49` mints a new UUID and rewrites `payload.id`; the locked test `apps/api/src/routes/webhooks.test.ts` asserts a new id | Test and code win. Do not change the replay behavior in this lane. Step 18 corrects the docs instead. |
| C9 | `apps/api/src/routes/adminMerchants.ts:53-56`, `docs/ADMIN.md:103-107`, `db/migrations/0068_webhook_delivery_archives.sql:35-37`: archives are paged and compressed | One unbounded SELECT and one `JSON.stringify` into a `TEXT` column (`apps/api/src/webhooks/archiveReplay.ts:45-52`, `:63-75`) | Code wins, and the uncapped capture is a deliberate compliance choice per the schema comment at `db/migrations/0068_webhook_delivery_archives.sql:30-34`. No cap is added. Step 18 documents the memory cost. |
| C10 | `apps/api/src/webhooks/replayBatch.ts:19-20`: the route rejects `succeeded` | The route checks only that `statuses` is a non-empty array (`apps/api/src/routes/adminMerchants.ts:230-235`) | Code wins, and the UI intentionally offers all four statuses. Step 11 adds enum validation, which keeps `succeeded` allowed. |
| C11 | `apps/api/src/webhooks/secretCrypto.ts:29`: encryption is deterministic so ciphertexts can be compared | A fresh random IV per call (`apps/api/src/webhooks/secretCrypto.ts:30-38`) | Code wins. Step 9 corrects the comment. |
| C12 | `apps/api/src/app.ts:71`: inbound verify rejects unsigned requests | `apps/api/src/webhooks/inboundVerify.ts:52-56` returns valid when the flag is false | Code wins. Step 1 changes the deployment posture, not the default. |
| C13 | `docs/ARCHITECTURE.md:95` lists `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` default `false` | Matches the code | No change. This is the one inbound doc that is correct. |

Anchor corrections worth recording, because the audits carried small drift:

- The outbound audit cites lines 90 to 104 for `apps/api/src/webhooks/testSend.ts`; the file
  is 72 lines and the response echo is at `apps/api/src/webhooks/testSend.ts:66-71`.
- The outbound audit cites `apps/api/src/acquirer/processRefund.ts`; the file is
  `apps/api/src/payments/processRefund.ts`.
- `docs/bugs/H-12.md` cites the unsigned-callback test at lines 171-187; the test is at
  `apps/api/src/routes/acquirerCallbacks.test.ts:124-140`.
- `docs/EXPLANATIONS.md:229-233` cites migration `0073`; the tree has no `0073` until step 3
  adds it.

---

## 5. Risks and out of scope

### Frozen or protected things this plan must not touch

- **`packages/money/` and `apps/settlement/internal/money/`.** Both are frozen after the Q2
  audit. No step here needs them. Any change requires finance approval and re-certification.
- **Existing test files.** Tests are regression-locked. Several pin the very behavior this
  plan works around: the unsigned-callback acceptance
  (`apps/api/src/routes/acquirerCallbacks.test.ts:124-140`), the new-id-on-replay assertion
  (`apps/api/src/routes/webhooks.test.ts`), and the poisoned-row attempt count
  (`apps/api/src/webhooks/dispatcher.test.ts`). New coverage goes in new files only.
- **The 501 stubs and the `v1/` partner API.** Nothing in this plan removes or changes a
  route that currently returns 501.

### Concurrent work

Other agents are editing this repo at the same time. The audit itself saw 50 changed files
and 29 modified test files in the working tree. Re-run `git status --short` before every
step, re-read any file that has moved since this plan was written, and never revert someone
else's change to make a step fit.

### Design risks in the steps themselves

- **Raw body capture (step 4).** Fastify's JSON parsing is global; the fix must scope the
  capture to the acquirer plugin, or every route grows a buffer it does not need. If the
  `preParsing` approach fights the existing parser, stop and report rather than weakening the
  signature to a re-serialization again.
- **Freshness gating (step 5).** Enforcing only when `requireSignature` is true is a
  compromise forced by the locked test. It means a development deployment with the flag off
  still accepts replayable signed callbacks. That is acceptable because the shipped env from
  step 1 turns the flag on, but do not describe it as full replay protection.
- **SSRF blocking (step 10).** Production-only blocking keeps local receivers working. A DNS
  name that resolves to a private address at request time can still slip past a
  registration-time check. That residual risk stays open and is documented here, not hidden.
- **Replay id contract (section 4, C8).** Changing replay to reuse the old id would be a
  cleaner contract but breaks a regression-locked test. The plan deliberately leaves the code
  as is and fixes the docs. If the owner wants the contract change, it needs a test-file
  policy exception first.
- **Refund delivery (step 14).** Gated. Applying it without a decision contradicts
  `AGENTS.md:59-61`; skipping it leaves a known gap. Make the owner choose explicitly.
- **Archive memory (section 4, C9).** Wide-range archives build one large JSON string in
  memory. A cap would violate the deliberate completeness rule, so the plan documents the
  cost instead of silently adding a limit.

### Deliberately out of scope

- **Multi-replica delivery.** The dispatcher has no `SKIP LOCKED`
  (`apps/api/src/webhooks/dispatcher.ts:222-231`) and the process assumes one replica. Making
  it safe for more than one replica is a separate design change.
- **Webhook secret re-encryption.** Rotating the app-level
  `WEBHOOK_SECRET_ENCRYPTION_KEY` without re-encrypting stored secrets breaks every delivery.
  No tool exists; this plan does not build one.
- **A receiver-side verifier product.** `verifySignature` (`apps/api/src/webhooks/sign.ts:79-108`)
  exists but has no production consumer. Shipping a merchant "verify your secret" tool is a
  product feature, not a fix.
- **A sandbox callback producer.** The simulator sends nothing
  (`apps/api/src/acquirer/simulator.ts`). Every verification in step 2 to step 5 uses manual
  curl. Adding a simulator path is useful for demos but not required to close the defects.
- **List rebuilds and dashboard redesigns.** Steps 15 to 17 add the missing affordances only.
  They do not restructure the pages.
