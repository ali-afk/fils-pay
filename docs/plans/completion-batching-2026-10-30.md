# Plan: "completion batching" — evaluation + how-to-implement

> Placement/convention: lives at `docs/plans/` per the planning-lane contract
> (same as the siblings `io-uring-optimization-2026-10-30.md`,
> `server-nginx-tuning-2026-10-30.md`, `db-query-retention-2026-10-30.md`).

| | |
|---|---|
| **Author** | AI planning lane (completion-batching evaluation) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — no repository file outside `docs/plans/` is created or edited by this document. |
| **Scope** | Evaluation of "completion batching — collecting batches of requests before processing them", compared against group commits / batch commits and every plan already in `docs/plans/` and `.omo/plans/`. A concrete implement plan is included for the only feasible shape, but it is **not recommended to start a lane now** (see Verdict). *Second pass 2026-10-30: the follow-up — what if we transition to an asynchronous API, and how would that affect the other plans? — is evaluated in the Addendum (§12). It does not reopen the "close this as a performance lane" decision, but it adds one genuinely feasible shape: server-side completion batching under an async API.* |
| **Audience** | The orchestrator deciding whether this optimization deserves a lane, and the implementer of the batch-commit lane (this document's comparison baseline). |

---

## Verdict (TL;DR)

**"Completion batching" is not a new mechanism; the phrase conflates two orthogonal
ones. As a server-side optimization it is either already implemented, already
planned, or incompatible with the synchronous API's design:**

1. **Server-side request accumulation** (the literal reading — an HTTP server
   collecting incoming completion requests and processing them later/grouped) is
   **not feasible for the partner API** without a contract change: each payment
   completion is a synchronous request/response whose transaction must commit
   *before* its response returns, holds a `FOR UPDATE` row lock across an awaited
   external acquirer call, and serializes on per-key idempotency rows. Batching
   them would force an async-submission + polling/webhook result contract, a new
   durable queue, and longer lock hold times — an API redesign, not an
   optimization. **Reject for the existing endpoints.** The one way to make it
   implementable is a full **async API transition** (move completion behind a
   `202 Accepted` + a platform-owned worker), which *is* possible and is evaluated
   in the Addendum (§12). As a *performance* play it is still not worth a lane.
2. **Group / batch commits** (fewer `COMMIT` round-trips for a set of independent
   items in one loop) is **already owned by `.omo/plans/batch-committing.md`** for
   the only open per-item-commit site: the settlement daily pass. Nothing in the
   payment API qualifies (each request's commit must precede its response).
3. **The "collect then process" pattern already exists in the outbox consumers**
   — the webhook dispatcher (`STEP_A`/`STEP_B` batch limits, one tx per pass) and
   the reporting consumer (`runConsumerPass`, one tx per batch). These are
   already batched and must not be reworked.
4. **The only genuinely new shape** — a client-coalesced **batch capture endpoint**
   (`POST /v1/transactions/batch-capture`, one request carrying N completions) —
   is **possible with constraints and low ROI at this scale**. It reduces HTTP
   round-trips, not DB commits (each sub-item still commits independently to
   preserve idempotency semantics). Not recommended to start now; gate on a
   measured partner need or a loadtest result, never on assumption.

**Recommended action: close the idea as a new lane now.** If a future demand
appears, the implementable shape is §8 (Option A) — and any *commit*-batching
desire routes to the existing `batch-committing.md` lane, not a new one.

---

## 1. Grounded inventory — what "completion" is in FilsPay

There is no existing feature or code named "completion batching"/"batch
completion" anywhere in `apps/` (grep 2026-10-30 across non-doc, non-test code).
The payment lifecycle's "completion" surfaces are:

| # | Completion surface | Shape | Anchors (verified on this tree) |
|---|---|---|---|
| C-1 | Partner API — capture a payment | Synchronous HTTP → one `withTransaction`; `FOR UPDATE` row lock held across the awaited acquirer call; idempotency claim + outbox event in the same tx | `apps/api/src/routes/transactions.ts:94` (`/:id/capture`); `apps/api/src/payments/capture.ts:94,123,174,180,240` |
| C-2 | Partner API — authorize / void / refund | Same synchronous per-request pattern | `apps/api/src/payments/{authorize,void,processRefund}.ts` (all `withTransaction`, see `withTransaction` users list) |
| C-3 | Acquirer out-of-band callback (`fraud_review.completed`) | One POST per verdict → SELECT + one `INSERT` (autocommit statements, no wrapping tx); dedup via `(transaction_id, callback_id)` `ON CONFLICT DO NOTHING` | `apps/api/src/routes/acquirerCallbacks.ts:45`; `apps/api/src/acquirer/callbacks.ts:38` |
| C-4 | Webhook delivery of `transaction.captured` / `settlement.paid` | Dispatcher collects ≤500 outbox events into `webhook_deliveries` in one tx (Step A), then attempts ≤100 due deliveries sequentially (Step B; HTTP call deliberately outside any tx) | `apps/api/src/webhooks/dispatcher.ts:23,24,88,146` |
| C-5 | Reporting of captures (`applyEvent` upserts) | Consumer collects up to `consumerBatchLimit` events and applies them + advances the watermark in ONE tx | `apps/reporting/src/consumer/runConsumerPass.ts:26,42` |
| C-6 | Settlement daily completion (close + pay a batch) | Loop over merchants, each `CloseBatch`+`PayoutBatch`/`PayoutSplitBatch` in its **own** tx — the one by-item-commit site | `apps/settlement/internal/settlement/batch.go:402,431,453,459`; will-of-design comment `:396` |

Cross-cutting facts that constrain any batching idea:

- **`withTransaction`** commits per call (`BEGIN` at `withTransaction.ts:28`, `COMMIT` at `:31`); the response returns only after the commit.
- **Idempotency** serializes on a unique `(merchant_id, endpoint, key)` index via `ON CONFLICT DO NOTHING` insert-blocking (`payments/idempotency.ts:120`) — the key is intentionally per-request and per-endpoint.
- **The API is a single low-spec unit**: `max: config.pgPoolMax` (`db/pool.ts:18`), 0.5 vCPU / 512 MB, budget why the pool is small (pool.ts comment).
- The platform communicates through a **transactional outbox + LISTEN/NOTIFY**; the outbox *is* the "collect, then process" queue (`docs/ARCHITECTURE.md`, "Events").

---

## 2. Reading 1 — server-side request accumulation: NOT feasible for the sync API

The literal idea — a server buffers incoming completion requests and processes
them in a batch — fails against C-1/C-2 on four independent grounds:

1. **Response semantics**: HTTP is synchronous. The merchant waits for `POST
   /:id/capture`'s response to proceed (checkout, order confirmation, retry
   logic). Collecting requests means no response until a flush — an **API
   contract change** (async `202 Accepted` + a completion webhook/polling
   endpoint + a client that survives the new latency), not an optimization.
2. **Row-lock duration**: `capture.ts` deliberately holds the `FOR UPDATE`
   lock *through* the awaited acquirer call (`capture.ts:123,174`; the "held on
   purpose" comment at `:77-79`). A group commit across requests would hold
   unrelated transactions' locks for the whole group's duration — the exact
   cross-merchant contention the settlement loop's design comment `batch.go:396`
   says it avoids. Processing a batch together would *widen* lock scope and
   *lengthen* lock time for no throughput gain at 0.5 vCPU.
3. **Idempotency semantics**: the claim → process → `completeIdempotencyKey`
   flow is built on "the response is written in the same transaction as the
   side effects" (`idempotency.ts`). Delaying the commit past the acquirer call
   is fine *inside one request*; buffering *multiple* requests moves the durable
   commit away from each request's logical completion, and a crash before flush
   needs a durable buffer — effectively re-implementing the outbox, which
   already exists for *events* but has no "hold a request until a batch flushes"
   role.
4. **Pool/CPU ceiling**: the pool is ≤5 and the box is 0.5 vCPU; there is no
   parallel horsepower that batching unlocks. Batching would *add* in-process
   buffering state for no resource win.

**Verdict: reject for the existing endpoints.** "Collect requests before
processing" is only meaningful where work is already collected by the platform —
which is the outbox consumers (Reading 3) and the settlement loop (Reading 3b).

The "contract change" this rejection depends on is evaluated in the Addendum
(§12): a full **async API transition** is possible and would give the platform
its own completion worker loop — turning "collect batches of requests before
processing them" into a literal, implementable job. For the synchronous contract
as-is, this rejection stands.

---

## 3. Reading 2 — client-coalesced batch endpoint: feasible, low ROI

The only reading of "completion batching" that is compatible with the codebase is
**the client does the collecting**: one request carries N completions, each
processed exactly as today.

- **Feasibility: high.** The endpoint is pure glue over the existing
  `captureTransaction`; per-sub-item idempotency, row locks, per-item commits and
  outbox events all keep working unchanged. No change to `capture.ts`,
  `idempotency.ts`, or schema. See §8 for the concrete plan.
- **What it actually optimizes:** HTTP round-trips / per-request overhead
  (headers, body parse, dispatch, auth middleware) for a single high-volume
  partner. It does **not** reduce DB commits — each item still `COMMIT`s before
  its result is returned (required to keep idempotency semantics). So it is
  **request coalescing, not commit batching** — the names must not be conflated.
- **Why not recommended now:** FilsPay's clients are per-transaction (one
  checkout = one capture); there is no observed bulk-capture partner driving
  demand; and at 0.5 vCPU a sequential N-item request is roughly N× a single
  request, only cheaper on transport. The honest win (round-trips) is smaller and
  more contract-heavy than the other lanes already in flight (io_uring, nginx,
  batch-commit).

**Verdict: possible with constraints; defer unless a measured partner need or a
loadtest (e.g. the `fp-209` harness) shows request overhead dominating.**

---

## 4. Reading 3 — collection-before-processing already exists; per-item commit sites + owners

Where FilsPay *does* "collect batches of requests/events before processing them",
it is already batched:

- **Webhook dispatcher** (C-4): Step A gathers every due event into `webhook_deliveries`
  in one tx (`dispatcher.ts:88,104`); Step B gathers every due delivery and
  attempts them in one pass (`dispatcher.ts:23,227`).
- **Reporting consumer** (C-5): one tx per batch of `consumerBatchLimit` events,
  atomic with the watermark (`runConsumerPass.ts:26,42`).
- **Ledger rebuilds / recalc / import loops**: one tx per whole pass (documented
  in `batch-committing.md` §4).

The **only open per-item-commit site** the platform has is the settlement daily
pass (C-6): `RunDailyBatch` commits ~2N times (close+payout per merchant) —
**already owned** by `.omo/plans/batch-committing.md` (primary change: one outer
tx with savepoints; secondary: multi-row inserts + `ON CONFLICT DO NOTHING` in
`EnqueuePayoutNotifications`). This is the true "group commits / batch commits"
target.

Two per-item sites that stay as-is, deliberately:

- **Dispatcher Step B's per-delivery UPDATE**: the outcome of each HTTP call is
  its own row state; grouping the UPDATEs after the sends would lengthen the
  window between send and recorded outcome and change retry semantics. The
  comment at `dispatcher.ts:146` (HTTP deliberately not in a DB tx) is the
  contract. Out of scope.
- **Acquirer callbacks (C-3)**: per-callback, append-only, deduped by unique
  pair; no wrapping tx today, and each callback is independent. Relative to the
  other cost centers this is noise; grouping adds latency for zero win. Out of
  scope (matches the "not worth a lane" reasoning of `prepare-once`).

---

## 5. Comparison — completion batching vs group commits / batch commits

`.omo/plans/batch-committing.md` is the reference for "group/batch commits". The
two are **not substitutes**; they are a mechanism and a placement:

| | Group commits / batch commits (`batch-committing.md`) | "Completion batching" (this idea) |
|---|---|---|
| Cost targeted | `COMMIT` round-trips / WAL fsyncs in a per-item loop | HTTP request round-trips (if a batch endpoint) or nothing distinct (if read as group commits) |
| Mechanism | Widen transaction boundaries (N commits → 1, savepoints for per-item atomicity) | Collect N requests and process together |
| Where it applies | A loop that already holds many independent items (settlement pass) | Only a client-coalesced batch endpoint on the sync API; NOT a server-side gather |
| DB commit effect | 2N → 1 per pass | None (per-item commits preserved) |
| Contract impact | None (same `CloseBatch`/`PayoutBatch` signatures) | New endpoint + client change |
| Owner | `.omo/plans/batch-committing.md` (proposed, docs-only) | nothing — this doc recommends closing it |

**Two sentences that answer the question directly:** if "completion batching"
means *fewer commits for a collected batch of work*, it *is* group/batch
committing, and the platform's only such site (settlement completion) is already
planned in `batch-committing.md` — do not fork a parallel plan. If it means
*fewer HTTP round-trips for many synchronous completions*, that is a batch
*endpoint* (Reading 2), which is the only new thing, and it is request-coalescing,
not commit-batching — defer (§3).

---

## 6. Exhaustive comparison — every plan already in `docs/plans/` and `.omo/plans/`

This is the complete inventory of plan documents in both directories (verified
2026-10-30 as of writing; `docs/plans/` and `.omo/plans/` are untracked dirs on
this tree). `docs/plans/` is live: the siblings
`idle-connection-shedding-2026-10-30.md`, `buffer-direct-response-assembly-2026-10-30.md`
and `site-serving-cloud-dashboard-2026-10-30.md` all landed while this document
was being written — each is included below, and any later plan landing in these
directories should be compared against this table the same way.

| Plan | What it is | Relation to completion batching | Addressed by |
|---|---|---|---|
| `.omo/plans/batch-committing.md` | Group/batch commits for the settlement daily pass (`2N` commits → 1 outer tx + savepoints; multi-row inserts; `EnqueuePayoutNotifications` → `ON CONFLICT DO NOTHING`) | **The** "group commits / batch commits" comparison target. Completion batching *as* commit-batching collapses into it | This doc, henceforth the only completion-batching authority: any commit-batching work routes here |
| `.omo/plans/prepare-once-and-connection-reuse.md` | **REJECTED** (drivers auto-cache prepared statements; single-connection harmful at pool level) | Same evaluation genre; establishes the "not worth a lane" precedent and the verdict structure this doc mirrors | Out of scope (rejected, no lane); its "real lever = batch-commit lane" conclusion corroborates §2 of this doc |
| `.omo/plans/io-uring-optimization.md` (run plan) + `docs/plans/io-uring-optimization-2026-10-30.md` | Kernel I/O-queueing report/plan (seccomp gate, PG18 async I/O, Bun runtime, "leave Go settlement alone") | Related as "batching I/O" at the syscall level — **mechanism is unrelated** (io_uring batches syscalls, not SQL commits or HTTP requests) | Out of scope here; no interaction with a (deferred) batch endpoint; read-only cites `batch-commit` lane for pgx COPY |
| `docs/plans/server-nginx-tuning-2026-10-30.md` | Host/nginx parameter plan; addendum: `dilmune` is a bare droplet behind Cloudflare + managed nginx | Related at the transport layer (keep-alive / connection reuse reduces per-request overhead — the *actual* cheap win for many-requests, versus a batch endpoint) | Out of scope; complementary. If a future batch endpoint or many-small-requests case appears, prefer nginx/TLS/keep-alive first |
| `docs/plans/db-query-retention-2026-10-30.md` | `transaction_events` index + `outbox_events` retention | Unrelated to batching; its retention half is bounded by the same outbox consumers this doc lists as already-batched | Out of scope |
| `docs/plans/idle-connection-shedding-2026-10-30.md` | Adaptive keep-alive socket shedder on `apps/api`; pg pools already shed on driver timers (api 30 s, reporting 10 s); LISTEN clients must not be shed | Transport-level resource control (sockets/FDs), coordinated with the nginx lane — **not** request or commit batching; targets per-connection overhead from the infrastructure side, complementing (not competing with) a future batch endpoint | Out of scope; complementary. Landed mid-task (sibling lane), included for exhaustiveness |
| `docs/plans/buffer-direct-response-assembly-2026-10-30.md` | Sibling evaluation — **verdict "no"** (pg is text-protocol, response bytes need JSON re-render; hot reads are DB/network-bound); recommends fast-json-stringify response schemas | Unrelated to completion batching (it concerns serializing *read* endpoints); an async transition issues trivial `202` bodies, so no interaction | Out of scope; complementary. Landed after this document's first pass; covered again in §12 |
| `docs/plans/site-serving-cloud-dashboard-2026-10-30.md` | Decision + implementer doc for serving the site from the cloud dashboard (reverse proxy to port 3000 vs static dir), coordinated with the nginx lane | Unrelated to completion batching (deployment/ingress choice); neither a batch endpoint nor an async transition changes how the site is served | Out of scope; complementary. Landed while this document was being written |
| `.omo/plans/fils-pay-bugfix-plan-2026-10-30.md` | Bug-fix implementation plan for the sabotaged base (H/S/P/M/R/L buckets, adversarial-layer index) | Unrelated (correctness fixes, not optimization) | Out of scope |
| *(Adjacent, outside the two dirs)* `docs/design/json-in-postgres-vs-app.md` | Set-based JSON processing (archive/replay bulks in SQL) | Related to batch-committing's "multi-row inserts" family; not request batching | Out of scope |
| *(Adjacent)* `docs/design/settlement-v2.md` | Paused settlement redesign (ADR 0005) — ledger-derivable batch totals | Not batching; if it ever resumes it supersedes parts of the settlement batching but not this evaluation | Out of scope |

No plan in either directory proposes a batch capture/completion endpoint; none
uses the phrase "completion batching". This document is the first statement on it.

---

## 7. What must not change (bindings on any implementation)

Same hard rules the sibling plans honor (repo `AGENTS.md`):

- **Never edit** `packages/money/` or `apps/settlement/internal/money/`; `parseBhdToFils`-only parsing. Money paths are frozen.
- **Test files** (`*.test.ts`, `*_test.go`) are regression-locked. A new endpoint adds a new test file for the new behavior; it never edits an existing test to fit.
- **`apps/api/src/v1/`** 501 stubs stay; **do not** add `refund.succeeded` to `WEBHOOK_ELIGIBLE_EVENT_TYPES` (ships in v1.9).
- **Lane ownership:** the batch-commit lane owns `apps/settlement/internal/settlement/{batch,allocate,payout_notify}.go`; the JSON-in-Postgres lane owns `apps/api/src/webhooks/*` set-based sites; other agents are mid-edit across `apps/api/**/routes/*.test.ts` and test fixtures on this tree. Any implementer must re-fetch/rebase and never touch a file another lane owns (this doc only *creates* `docs/plans/completion-batching-2026-10-30.md`).

---

## 8. Implementation plan — IF approved, the feasible shape (Option A: batch capture endpoint)

Framed for a separate implementation lane. Do **not** start unless the §3 gate
fires (a measured partner need or loadtest signal).

**Design invariant:** each sub-item is a full `captureTransaction` call in its
own `withTransaction`. The batch endpoint is transport-level glue only — zero
change to `capture.ts`, `idempotency.ts`, schema, or tests of existing behavior.
**Do not** wrap the batch in one outer tx with a single `COMMIT`: that couples N
transactions' row locks (violates the lock-scope rationale of `batch.go:396` and
`capture.ts:77`) and reorders outbox visibility for reporters (the
`batch-committing.md` §2.4 warning applies). Per-item commit is mandatory for
idempotency semantics (`idempotency.ts:120`).

Steps (each + its verification):

1. **Route** — `apps/api/src/routes/transactions.ts`: add
   `POST /v1/transactions/batch-capture` with the same auth as single capture
   (`requireMerchantAuth`; session or API key; each item carries its own
   `Idempotency-Key`). Body `{ items: [{ transactionId, amountFils?, idempotencyKey }] }`;
   reject `items.length < 1` or `> ITEM_CAP` (start 100); require each item's key
   (mirror `getIdempotencyKey` validation at `transactions.ts:55`).
   — Verify: `curl -i -X POST .../v1/transactions/batch-capture` returns 400 on
   missing/empty/over-cap items; 200 on a valid 2-item body.
2. **Handler glue** — for each item call `captureTransaction(pool, acquirer,
   { transactionId, merchantId, amountFils, idempotencyKey, actor })` inside a
   `try/catch`; collect `{ transactionId, statusCode, body }`; never let one item
   abort the rest; return `200 { items: [...] }`. Start **sequential** (simplest;
   no added lock contention). — Verify: 2 items → both statuses present and
   correct; one bad idempotency key ⇒ 422 for that item, the other still 200.
3. **Test** — new `apps/api/src/routes/transactions.batchCapture.test.ts` modeled
   on the existing test shape: happy 2-item; per-item failure isolation; duplicate
   idempotency key replay within the batch returns the cached per-item response;
   a concurrent duplicate request with the same keys serializes on the idempotency
   index (no double capture). — Verify: `bun test` green; existing tests untouched.
4. **Measure, then (optionally) parallelize** — run the batch against the dev DB
   through the `fp-209` loadtest harness *before and after*; add bounded
   per-request concurrency (an in-process worker fan-out of ≤ `pgPoolMax - 1`)
   only if the measurement shows per-item DB time (not the acquirer RTT)
   dominating. — Verify: before/after histograms on file.
5. **Full gate** — `bun test` green | `cd apps/settlement && go test ./...` green
   | `bun run typecheck` green | `git status` shows only this new route + test +
   this plan.

**If the intent is instead "fewer commits for settlement completion":** do not
build here — that is `.omo/plans/batch-committing.md`; implement that.

---

## 9. Verification of *this* plan document (for the orchestrator/reviewer)

- Anchor integrity: every `file:line` above was re-verified against this tree on
  2026-10-30 (rg) before writing; spot-check the captures table (§1) and the
  comparison target (`batch-committing.md`).
- Exhaustiveness: the §6 table lists every plan file then present in
  `docs/plans/` + `.omo/plans/` and addresses each (the directories are live — a
  sibling added `idle-connection-shedding` and later the
  `buffer-direct-response-assembly` plan while this document was being written;
  both are covered, and §12 adds the async-transition reading). Adjacent
  `docs/design/*` docs are named as out-of-scope.
- Scope: `git status --porcelain` shows this document as the **only** new file
  from this lane; nothing else in the tree was created or modified by this plan.

---

## 10. Risks

- **Conflation risk** (the reason for this doc): a future lane reading "completion
  batching" might re-do `batch-committing.md` under a new name, or ship a
  group-commit batch endpoint that breaks lock-scope/visibility guarantees. This
  doc's §2/§5 are the guardrail.
- **If Option A is ever built**: idempotency-key cardinality grows (one key per
  item per call) — cheap, but verify the unique-index path stays index-backed
  (`idempotency.ts:114` flags a staging scan suspicion; re-`EXPLAIN` before
  shipping a high-volume endpoint).
- **Redirecting demand to nginx/keep-alive** is the right cheap win for
  many-requests; do not trade it for a contract-changing endpoint without a
  number.

---

## 11. Decision record

- **2026-10-30** — evaluated "completion batching". Verdict: **close as a new
  lane**. Server-side request accumulation is incompatible with the sync API;
  commit-batching is owned by `batch-committing.md`; outbox consumers already
  batch. If a future, measured need for a bulk-capture surface appears, implement
  §8 Option A (client-coalesced batch endpoint, per-item commits) — request
  coalescing, not commit batching. Commit footer for any future implementation:
  `Plan: docs/plans/completion-batching-2026-10-30.md`.
- **2026-10-30 (second pass)** — follow-up: **transition to an async API?**
  Possible — the platform already has the outcome channel (`transaction.captured`
  webhook), a durable queue (outbox + LISTEN/NOTIFY + poll), a status surface
  (`GET /v1/transactions/:id`), and `in_progress|completed|failed` idempotency.
  It unblocks §2's server-side accumulation (a capture processor becomes the
  collector), but it is a product/architecture decision with wide plan impact
  (see Addendum §12), not a performance optimization. Do not start a lane now;
  if pursued, gate it behind a feature flag and keep the sync surface.

---

## 12. Addendum — an async API transition: possible, and it makes "completion batching" real

> Second pass, 2026-10-30. Answers the follow-up: *"what if we transition to an
> asynchronous API — is that not possible? how will that affect other plans?"*
> This amends §2's rejection, which was scoped to the **synchronous** contract.

**Short answer: yes, it is possible — and it is the one contract change §2 point 1
named as the only thing that unblocks server-side completion batching.** Moving
completion behind a `202 Accepted` + a platform-owned worker means the server
starts "collecting batches of requests before processing them" literally: the
worker *is* the collector. The honest framing: this is an architecture / product
decision with wide plan impact (12.4), not a performance optimization — the commit
savings it enables are already cheaper via `batch-committing.md`.

### 12.1 Every building block already exists

| Need | Already in the tree | Anchor |
|---|---|---|
| Outcome as event | every capture enqueues `transaction.captured` in the capture tx; it has a webhook envelope and is already webhook-eligible | `payments/capture.ts:240`; `webhooks/envelope.ts:9,43,46`; `webhooks/dispatcher.ts:29` |
| Durable queue + wake-up | the outbox (`enqueueEvent`) + LISTEN/NOTIFY on `outbox_events_channel` + poll fallback | `packages/events/outbox.ts:83`; `webhooks/dispatcher.ts:33,314,323` (poll `setInterval`) |
| Loop to copy | the reporting consumer: one tx per batch of ≤N, cursor persisted atomically with the work | `reporting/src/consumer/runConsumerPass.ts:26,42` |
| Status surface for polling | `GET /v1/transactions/:id` | `transactions/query.ts:145`; `routes/transactions.ts:179,196` |
| Spanning-state idempotency | `in_progress → completed/failed` state machine (nothing returns the body before `completeIdempotencyKey`) | `payments/idempotency.ts:29,178,188,213` |

So an async completion path is mostly **wiring that already proves out**, not new
infrastructure.

### 12.2 The minimal viable shape

1. **New async surface, sync path untouched** — the partner API contract
   (`apps/api/src/v1/`, `HANDOVER`: "leave v1 alone") keeps serving current
   partners. Add e.g. `POST /v1/transactions/:id/capture-async` (auth as today)
   → validate → return `202 { captureRequestId, idempotencyKey, statusUrl }`;
   commit a durable claim (idempotency row `in_progress` + an outbox/jobs row) in
   the same tx. Outcome is delivered out-of-band by the existing
   `transaction.captured` webhook *and* by `GET /v1/transactions/:id`.
2. **A capture processor** — an in-process component in `apps/api` started after
   `app.listen`, exactly the `startWebhookDispatcher` precedent (`index.ts`).
   LISTEN + poll fallback; each pass claims a bounded batch of pending capture
   work and runs the existing `captureTransaction` body per item (`FOR UPDATE`
   lock, acquirer call, ledger + event + idempotency finalize). Each item in its
   **own** short tx — the graph shape where §5 / `batch-committing.md`'s
   group-commit technique (one outer tx per pass, savepoints) can later apply
   (12.4).
3. **Idempotency ownership nuance** — `claimIdempotencyKey` returns
   `conflict_in_progress` for an already-`in_progress` row ("orphaned in_progress
   row (crashed process) — reject, never proceed", `:29,178`). Under async the
   request tx owns the claim; the worker must **not** re-run `claimIdempotencyKey`
   on it — it claims **work rows** (`SKIP LOCKED` or the single-replica rule) and
   finalizes the idempotency row at completion. This adds a small "stuck async
   request" watchdog (mark a request failed after a timeout); sync semantics
   don't need it because the claim's insert-blocking serialises the response.
4. **Concurrency rule** — dispatcher precedent: `no SKIP LOCKED — only ever run
   ONE api replica` (`dispatcher.ts:217`; `index.ts:29`). The processor inherits
   that unless it adds `SKIP LOCKED` claiming; document which.

### 12.3 Costs / honest trade-offs

- **Contract + UX.** Current checkout and payment links block on the capture
  response; payment links call `captureTransaction` synchronously
  (`paymentLinks/pay.ts:101,121,125`, actor `system`). Under async they'd need a
  delayed-outcome flow (or stay sync), and every integrated partner's
  decline/error handling moves to the webhook/poll.
- **Latency shift, not removal.** Completion latency becomes "worker tick + poll
  interval + acquirer RTT" — seconds, in a different budget. Declines and
  acquirer failures arrive late; `failIdempotencyKey` marks them and the merchant
  sees the outcome after the fact.
- **Operational surface.** A new long-lived consumer (LISTEN + poll + cursor), a
  stuck-job watchdog, and the 0.5 vCPU / 512 MB container hosts another in-process
  loop (the dispatcher proves the loop is feasible in-process).
- **Money timing is unchanged.** Ledger legs, `merchant_balances`, fee resolution
  and settlement close still key off capture completion — only *when* that
  completion happens moves. Nothing about money movement or `packages/money/`
  changes.

### 12.4 Effect on the other plans (the asked question)

| Plan | Effect of an async transition |
|---|---|
| `.omo/plans/batch-committing.md` | **Mechanism unchanged** (settlement closes whatever is unbatched at close time, now fed by worker-completed captures) — but the capture processor is a **new loop-shaped commit site**, exactly the shape group commits target (N items, one process, per-item atomicity). The batch-commit technique (Option A/B, savepoints) transfers to the worker pass, and its "not candidates — API request paths… inherent" note gains a candidate once the worker exists. Documentation touchpoint, not a rewrite. |
| `.omo/plans/prepare-once-and-connection-reuse.md` | **No impact** — REJECTED stands; the processor reuses the same small pool. |
| `io_uring` (`.omo` run plan + `docs/plans/io-uring-optimization-2026-10-30.md`) | **No impact** — orthogonal (kernel I/O queueing). |
| `docs/plans/server-nginx-tuning-2026-10-30.md` | **Minor, helpful** — async returns short `202`s so request-handling time drops; its keep-alive guidance still stands; no edit needed. |
| `docs/plans/idle-connection-shedding-2026-10-30.md` | **No conflict, complementary** — fewer HTTP requests held open across an awaited acquirer call; the shedder's high-water logic is unaffected. |
| `docs/plans/db-query-retention-2026-10-30.md` | **Real touchpoint** — if capture work routes through `outbox_events`, the processor becomes a **second consumer**; the retention plan's safe-deletion frontier (`reporting_outbox_cursor`, `consumer/cursor.ts`) is keyed to reporting only, so it must account for the processor's own cursor before any `DELETE` (else it could prune rows the worker still owns). If a dedicated `capture_requests` table is used instead, its growth/retention must be designed in. |
| `docs/plans/buffer-direct-response-assembly-2026-10-30.md` | **No impact** — it concerns serializing *read* endpoints; async completion endpoints return trivial `202` bodies; its fast-json-stringify recommendation is orthogonal. |
| `docs/plans/site-serving-cloud-dashboard-2026-10-30.md` | **No impact** — a deployment/ingress decision (reverse proxy to :3000 vs static dir), orthogonal to how captures complete; the serving plan's port/upstream choices are unaffected by async endpoints. |
| `.omo/plans/fils-pay-bugfix-plan-2026-10-30.md` | **Ordering, not content** — the tree is the sabotaged base; async work must not start until the bug-fix lanes land (capture/auth/idempotency correctness are preconditions). |
| `docs/design/json-in-postgres-vs-app.md` | **No impact** — set-based JSON processing is orthogonal. |
| `docs/design/settlement-v2.md` | **No impact** — paused redesign; ledger-derivable totals orthogonal. |

### 12.5 Recommendation

**Possible, but do not begin a lane now.** The async transition's value is a
*different completion contract* for high-volume or UX-tolerant partners — not
latency or commit throughput, which `batch-committing.md` covers more cheaply.
If you pursue it, in order: (a) gate it behind a feature flag on the `parseBoolEnv`
pattern (`config.ts:148`); (b) keep the sync surface untouched; (c) reuse the
dispatcher/processor loop and the existing `transaction.captured` event instead of
introducing a broker; (d) let the batch-commit technique own worker-pass commit
batching once the worker exists; (e) sequence it strictly after the bug-fix lanes.
Writing a dedicated `async-api-transition` plan *is* warranted if the decision is
taken — this addendum deliberately stays an evaluation.