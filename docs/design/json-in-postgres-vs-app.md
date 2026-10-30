# JSON processing: in PostgreSQL vs in the app — decision plan

> **Status: PLAN ONLY (no code changed).** This is the *how-we-will-do-it*
> document for the "JSON in Postgres vs in app" evaluation lane. It inventoried
> every JSON processing site in the repo, reasoned about each, and recommends
> which belong in PostgreSQL and which must stay in the app. Implementation is
> a separate, later lane; nothing here has been edited in `apps/`, `packages/`,
> or `db/migrations/`.
>
> Guardrail per `AGENTS.md`: **nothing in `packages/money`, no test file
> edits, no widening of monetary columns, no new `refund.succeeded`
> webhook eligibility, and the `v1/` 501 stubs stay put.**

## 1. The question, scoped

"Where is JSON processing in PostgreSQL better than doing it in the app?" is
two different questions and we must keep them apart:

1. **Where should the *data flow* keep JSON out of the app entirely** — i.e.
   build/read a JSON document inside a single SQL statement so it never
   round-trips through JS `JSON.stringify`/`JSON.parse`? (Set-returning
   jsonb functions, `jsonb_agg`, `jsonb_build_object`, keyset handling in SQL.)
2. **Where should the *data stay* as JSON in the DB at all** — i.e. is a
   `jsonb` column the right storage, vs normalizing into columns/relations?

The repo already has a stated position on #2 in `ARCHITECTURE.md` (jsonb for
opaque envelopes: outbox, webhook, audit, transaction metadata) and in
commentary at every call site ("filter_json is opaque JSONB, never interpreted
at write time"). **This plan does not reopen #2** — the opaque-jsonb design is
intentional and correct for these sites. The only open question is **#1 where
the "processing" (build / read / transform) happens.**

The rule we apply: **JSON processing should live where the *view of the data*
it serves lives.** A transform that serves a set-based read (an archive that is
a whole endpoint's delivery history, a batch replay that re-inserts N rows)
gets pushed into SQL so the app never materializes the full set. A transform
that serves a *single, interactively-shaped object* the app will re-serialize
anyway (a public webhook envelope) stays in the app, because pushing it into
SQL would make the SQL the version-contract and cost the JS-side field-by-field
mapper that exists precisely to keep the two independently versionable.

## 2. Inventory of JSON processing sites (current state)

| # | Site (file) | What processes JSON | Where today | App/DB |
|---|---|---|---|---|
| 1 | `packages/events/src/outbox.ts` `enqueueEvent` | `JSON.stringify(payload)` → `outbox_events.payload` | insert | app |
| 2 | `apps/api/src/payments/idempotency.ts` | `canonicalJson`/`sortKeysDeep` + `hashRequest` (`sha256`) of request body; `JSON.stringify` of response body → `response_body` | hash + stringify | app |
| 3 | `apps/api/src/webhooks/dispatcher.ts` `createMissingDeliveries` | `(oe.payload->>'merchantId')::uuid` join predicate (JSON extraction **already in SQL**); then `buildEnvelope` + `JSON.stringify` per row | extraction = DB; envelope = app | both |
| 4 | `apps/api/src/webhooks/envelope.ts` `buildEnvelope` | field-by-field wrapper of outbox payload → public webhook envelope (renames `newStatus`→`status`, selects fields) | app | app |
| 5 | `apps/api/src/webhooks/archiveReplay.ts` `createWebhookDeliveryArchive` | reads an **entire date range of deliveries into JS**, builds `entries[]`, `JSON.stringify(entries)` → one `archive_payload` jsonb row | app | app |
| 6 | same file, `replayWebhookDeliveryArchive` | `JSON.parse(archive_payload)` → loops `insertReplayDeliveryRow` per entry | app | app |
| 7 | `apps/api/src/webhooks/replayBatch.ts` + `replay.ts` | SELECT up to 500 candidate rows, loop `insertReplayDeliveryRow` (each rebuilds `replayPayload` + new uuid + `JSON.stringify`) | app | app |
| 8 | `apps/api/src/reporting/savedFilters.ts` | opaque `filter_json` jsonb, never interpreted at write | app (no-op) | app |
| 9 | `apps/api/src/transactions/events.ts` `recordTransactionEvent` | `JSON.stringify(metadata ?? {})` → `transaction_events.metadata` | app | app |
| 10 | `apps/api/src/adminAudit/log.ts` | `JSON.stringify(metadata)`; **merge patch is already `metadata = metadata || $3::jsonb` in SQL** for `markAdminAuditOutcome` | app (write); DB (merge) | both |
| 11 | `apps/api/src/reporting/transactionsReportQuery.ts` | after reading a saved filter, builds SQL conditions per JSON field (interpretation) | app | app |

Supporting DB-side machinery that already exists (so this plan *extends* a
pattern, it does not introduce one): `notify_outbox_event()` trigger function
(migration 0021), views `merchant_payable_position` / `v_unbatched_capture_events`
/ `v_active_api_keys` (0054), `live_sessions` (0058).

## 3. The decision per site

### WHERE POSTGRES WINS — push into SQL (AND would be an actual improvement)

These serve a **set-based view**; today the app materializes the whole set in
JS just to rebuild the same JSON in a different aggregate shape. This is the
single clearest "better in Postgres" case and the only one worth doing.

- **Site 5 — `createWebhookDeliveryArchive`** (archive build): today the app
  plays `SELECT` (all N rows) → map to JS objects → `JSON.stringify` → one
  insert. All of that is `jsonb_agg(jsonb_build_object(...))` in one
  `INSERT ... SELECT`, and it removes reading N rows into the Node heap just to
  turn them back into one JSON document. **Plan: single SQL statement.**

- **Site 6 — `replayWebhookDeliveryArchive`** (archive replay): today it
  `JSON.parse` a whole archive then loops `insertReplayDeliveryRow` (an INSERT
  per entry). That is `jsonb_array_elements(archive_payload)` feeding a
  set-based `INSERT ... SELECT`, one statement for the whole archive. The
  per-row signature re-sign and uuid freshness (below in Site 7) apply here too.
  **Plan: single SQL statement.**

- **Site 7 — `replayBatch.ts`** (batch replay, cap 500): today it selects up to
  500 rows and loops 500 inserts. This is where "a bounded unit of work" is
  already a stated constraint; the improvement is to do it in one
  `INSERT ... SELECT` over the candidate `SELECT`, generating the fresh uuid and
  `replay_of_delivery_id` in SQL, keeping the batch atomically in one statement
  (which is already the transactional intent). **Plan: collapse loop to
  set-based SQL**, keeping `replay.ts`'s `insertReplayDeliveryRow` for the
  single-delivery path (a narrow, cheap path that needn't change).

The signature/freshness semantics must be preserved *exactly*: replay mints a
**new** `delivery_event_id` (receiver dedupe constraint, documented in
`replay.ts`) and **re-signs fresh (never resends original bytes)**. In SQL that
means the set-based insert generates `gen_random_uuid()` per row for
`delivery_event_id`, sets `replay_of_delivery_id` from the source row, and the
later dispatcher pass re-signs with current time exactly as it does today. The
envelope's `id` field so replay inserts `payload || jsonb_build_object('id',
delivery_event_id)` so the stored body and the dedupe header agree.

### WHERE POSTGRES ALREADY WINS — keep, don't touch

- **Site 3's JSON extraction** — `(oe.payload->>'merchantId')::uuid` in the
  dispatcher's join. Handled in SQL, correct, and un-movable (a join predicate
  can't be a JS transform). No change.
- **Site 10's merge** — `metadata = metadata || $3::jsonb`. Already the SQL
  jsonb merge operator. No change.

### WHERE THE APP SHOULD KEEP IT — and the reason

- **Site 2 (idempotency hashing)** — must stay in the app. The
  canonical ordered-key `sha256` is crypto-grade request-dedup and is deliberately
  a JS function (`sortKeysDeep`) asserted by `idempotency` logic; there is no
  reason to move a hash computed on a request body the app already holds in
  memory before it touches the DB. Moving it buys nothing.
- **Site 4 (`buildEnvelope`, the public webhook envelope)** — must stay in the
  app. This is the one deliberate field-by-field contract mapper; moving the
  rename/wrap into `jsonb_build_object` SQL would make the *envelope shape* a
  byproduct of a SQL string instead of a versionable, unit-tested JS module.
  The design note in `ARCHITECTURE.md` ("outbox payload vs public envelope are
  independently versionable") is exactly this. Keep.
- **Site 1, 8, 9, 11 (single-object opaque payloads)** — neutral; the app
  `JSON.stringify`s one small metadata/outbox/filter object it already holds.
  SQL gains nothing. Keep as-is.

## 4. The concrete how-we-will-do-it plan (for the implementation lane)

The work is **three SQL statement rewrites** (sites 5, 6, 7) using the repo's
existing migration + `bun test` + `go test` practices. No new columns, no
`packages/money` change, no test edits beyond the ones each changed function's
behavior already pins.

**Step 1 — Site 5, `createWebhookDeliveryArchive`.** Rewrite the body so the
app performs `WHERE endpoint_id = $1 AND created_at >= $2 AND created_at < $3`
with a single:
```sql
INSERT INTO webhook_delivery_archives
  (endpoint_id, merchant_id, created_by_admin_user_id, from_created_at, to_created_at, delivery_count, archive_payload)
SELECT
  $1, $2, $3, $4, $5,
  count(*)::int,
  COALESCE(jsonb_agg(jsonb_build_object(
    'deliveryId', wd.id,
    'outboxEventId', wd.outbox_event_id,
    'eventType', wd.event_type,
    'payload', wd.payload,
    'createdAt', wd.created_at
  ) ORDER BY wd.created_at ASC), '[]'::jsonb)
FROM webhook_deliveries wd
WHERE wd.endpoint_id = $1 AND wd.created_at >= $2 AND wd.created_at < $3
RETURNING id;
```
Verify: existing `archiveReplay.test.ts` still green (it pins the archive row
shape and the audit log count); run a manual archive against a seeded endpoint
and confirm `archive_payload` equals what the old JS path produced modulo
key order.

**Step 2 — Site 6, `replayWebhookDeliveryArchive`.** Replace
`JSON.parse` + per-entry `insertReplayDeliveryRow` loop with one
`INSERT ... SELECT` from `jsonb_array_elements($archive::jsonb)`, generating
`gen_random_uuid()` per row and `replay_of_delivery_id = entry->>'deliveryId'`,
with `payload = (entry->'payload') || jsonb_build_object('id', delivery_event_id)`.
Verify: `archiveReplay.test.ts` green; a replayed endpoint receives one
pending delivery per archive entry with a fresh delivery id (no header/body id
mismatch).

**Step 3 — Site 7, `replayBatch.ts`.** Collapse the up-to-500 loop into one
`INSERT ... SELECT ... FROM webhook_deliveries` applying the same
`LIMIT $5` candidate predicate the route already uses, in the same single
transaction, so the audit `replayedDeliveryIds` is derived from `RETURNING id`.
Verify: `routes/webhooks.test.ts` (batch replay) green; the
"400 requeued + no audit row on audit write failure" atomicity intent still
holds by construction (one transaction, one statement).

**Step 4 — full-suite verification** (repos own `AGENTS.md` gate):
```
bun test && cd apps/settlement && go test ./...
```
plus `bun check` (or tsc) typecheck on the changed files, and a manual end-to-end
exercise of each changed surface (archive a seeded range; replay it; run a batch
replay) with captured curl evidence.

**Safety / stop conditions for the implementation lane:**
- Stop immediately and revert if any existing test fails **because the SQL
  shape changed a pinned value** — the envelope field names, `createdAt`
  rendering (`timestamptz` microsecond vs `toISOString()` millisecond
  precision), or key ordering in `archive_payload` must match the current
  behavior. `replay.ts`'s freshness/dedupe contract is not negotiable.
- Every rewritten statement keeps its current transaction boundary
  (`withTransaction`), its merchant scoping, its bounded batch, and its audit
  row — the non-negotiable invariants in each file's comments.
- No change is verified by a passing test alone; each gets a real-surface run.

## 5. What we will NOT do (the app-keeps-it set, stated so nobody "helpfully" relocates them)

- No `jsonb_path`/expression-index gymnastics for idempotency hashing.
- No moving `buildEnvelope`/`parseInboundWebhookPayload` schema into SQL.
- No GIN-index additions for `payload` columns now: it is a documented backlog
  item (FP-244) for `transactions` search via `pg_trgm`, not a jsonb-column
  problem, and out of scope for this lane.
- No widening any monetary column, no change to `packages/money`.

## 6. ADR note

If, after Step 3 lands, the team wants the "set-based JSON aggregation lives in
SQL; contract-shaped JSON lives in JS" rule made durable, add it as an ADR
(`docs/adr/0007-json-processing-locus.md`) following the existing pattern. Not
required to implement — recommended to prevent this exact "app vs DB" question
from being re-argued wheel-by-wheel.