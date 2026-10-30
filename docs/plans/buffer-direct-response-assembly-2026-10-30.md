# Design: assembling API responses directly into buffers from DB column bytes — feasibility & plan

> **Status: PLAN ONLY (no code changed).** This is the *evaluation + how-we-will-do-it*
> document for the "assemble responses directly into buffers from database column bytes"
> optimization lane. It inventories how responses are assembled today, verifies what the
> `pg` driver exposes, and gives a verdict plus a concrete implementation plan. Nothing in
> `apps/`, `packages/`, or `db/migrations/` has been edited.
>
> Guardrail per `AGENTS.md`: **nothing in `packages/money`, no test file edits, no widening
> of monetary columns, no new `refund.succeeded` webhook eligibility, and the `v1/` 501
> stubs stay put.** This lane touches only read-path serialization; it does not change any
> query result shape, currency rounding, or money formatting.

## 1. The question, scoped

Every JSON response the API returns today follows the same shape:

```
Postgres (text protocol) → pg parses column text into JS values (objects/rows)
  → serializeTransaction / serializeX maps to a DTO object
  → Fastify reply.send(dto) → JSON.stringify → HTTP response body (string)
```

The proposed optimization is to **skip the intermediate JS-object + `JSON.stringify`
hop**: read the raw column bytes the driver already has on the wire and append them
directly into the response buffer, writing the JSON framing (keys, `{`, `}`, `,`, quotes)
ourselves. The claim to test is: *can we cut allocation and CPU by assembling the JSON
response string directly from DB column bytes, instead of `pg` → JS object → DTO →
`JSON.stringify`?*

This is a **different axis** from the already-documented competing optimization
(`docs/design/json-in-postgres-vs-app.md`), which pushes *whole-document JSON aggregation*
into SQL (`jsonb_agg`/`jsonb_build_object`) so the DB emits a finished JSON document and
the app never materializes the set at all. That lane answers "where does the JSON get
built?" (DB vs app). This lane answers "**when** the app must build the JSON, can it write
it straight into a buffer from column bytes instead of through JS objects?" The two are
**complementary, not competing**: the SQL lane removes whole endpoints' materialization;
this lane is the fallback for the endpoints that must stay in JS (the set is small, or the
shape is a single interactively-versioned object).

## 2. Current response assembly path (with file:line evidence)

All line numbers verified against `main` on 2026-10-30. This lane only reads these files.

| # | Surface | Evidence | Assembly today |
|---|---|---|---|
| A | Transaction list | `apps/api/src/transactions/query.ts:107-137` (`listTransactions`: `SELECT *, occurred_at::text` → `result.rows.map(serializeTransaction)`), `apps/api/src/transactions/serialize.ts:29-43` (`serializeTransaction`: snake_case→camelCase, `Number()` on fils, `.toISOString()` on dates) | pg rows → DTO → stringify |
| B | Transaction report | `apps/api/src/reporting/transactionsReportQuery.ts:44-72` (`runTransactionsReport`: `formatBhd(toFils(Number(...)))` at `:68-69`, `.toISOString()` at `:71`) | pg rows → DTO → stringify |
| C | Analytics volumes / payout-trends / top-links / recent-ledger-activity | `apps/api/src/analytics/query.ts:111-138, 178-204, 235-259, 298-322` (each: `pool.query` → `rows.map(serializeX)` → DTO) | pg rows → DTO → stringify |
| D | Analytics routes | `apps/api/src/routes/analytics.ts:91-127` (return the DTO object directly; Fastify serializes) | Fastify default `JSON.stringify` |
| E | Reporting routes | `apps/api/src/routes/reporting.ts:25-51` (transactions report), `:53-78` (saved filters) | Fastify default `JSON.stringify` |
| F | Webhook archive / replay (already claimed by the JSON-in-Postgres lane) | `apps/api/src/webhooks/archiveReplay.ts:60-90`, `replayBatch.ts` | out of scope here |

**Key facts established:**

1. **No response schemas anywhere.** `rg "schema:|response:|fast-json-stringify|setSerializer" apps/api/src/routes apps/api/src/app.ts` returns nothing. Fastify therefore uses its **default serializer, `JSON.stringify`**, on the DTO object. There is no `fast-json-stringify` compiled schema in play today — so the *entire* serialization hop is plain `JSON.stringify` on a freshly-built object.
2. **The driver is `pg` (node-postgres) 8.23.0, text protocol, `binary: false`** (`node_modules/pg/lib/defaults.js`). Column values arrive as **text strings** on the wire; `pg` runs each through a type parser (`pg-types`) to produce a JS value (`node_modules/pg/lib/result.js:63-76`, `result.js:98-101`). The "column bytes" are therefore already text; `pg` has already decoded them into JS strings before our code sees them.
3. **`pg` exposes `rowMode: 'array'` and custom type parsers** (`node_modules/pg/lib/query.js:24`, `result.js:20-22`, `client.js:597-602`). Neither is used anywhere in `apps/` or `packages/` source today (`rg "rowMode|binary:|setTypeParser"` → none).
4. **Money columns are BIGINT, read by `pg` as strings** (`transactions/serialize.ts:14-15`, `analytics/query.ts` row interfaces) — the app converts with `Number()`. The report path additionally runs `formatBhd(toFils(...))` (`transactionsReportQuery.ts:68-69`), i.e. **money formatting is a JS transform that cannot be skipped**.
5. **Dates are `timestamptz` → `Date` → `.toISOString()`** in every serializer. The DB text rendering of a `timestamptz` (`2026-10-30 12:34:56.789+03`) is **not** valid JSON/ISO-8601 output (`2026-10-30T09:34:56.789Z`), so the raw column byte for a timestamp is *never* directly usable — it must be re-rendered. This is exactly the precision-sensitive case the code comments warn about (`query.ts:92-103` cursor encoding, `analytics/query.ts:44-49` `toDateString`).

## 3. Verdict — is it possible?

**Yes, technically possible; but in this repo it is a marginal-to-negative ROI and mostly a
"no".** Three reasons, in order of weight:

### 3.1 The bytes are already strings, and the JSON still has to be *re-rendered*, not copied

The premise "assemble from DB column bytes" only saves work if the raw bytes are directly
JSON-usable. In the text protocol they are strings, but **most columns need a transform
before they are valid JSON output**:

- **timestamps**: DB text `2026-10-30 12:34:56.789+03` ≠ JSON `2026-10-30T09:34:56.789Z`. Must re-render → the `.toISOString()` work is still done, just relocated.
- **money**: BIGINT-as-string must become `Number` (fils) or `formatBhd` (report BD string). `formatBhd` is a `packages/money` function — frozen, and the only place rounding is validated. The transform is mandatory and JS-side.
- **snake_case→camelCase keys**: `merchant_id` → `merchantId`. The JSON key strings are *not* the column names, so keys cannot be copied from the wire; they are constants the serializer must emit.
- **booleans / nulls / escaping**: a text column value containing `"` or `\` must be JSON-escaped. `pg`'s text parser does not escape; the buffer writer would have to.

So "copy column bytes into the buffer" only works verbatim for a minority of columns
(plain `text`/`varchar`/`uuid` fields whose value is already JSON-safe). For every other
column you are writing a hand-rolled JSON encoder that re-implements what `JSON.stringify`
does — while losing `pg`'s tested type parsing.

### 3.2 The real cost today is not the serialization hop

The load test (`docs/perf/fp-209-loadtest-2026-09.md`) shows the hot read endpoints are
**not serialization-bound**:

| Scenario | p50 | p95 | Max |
|---|---|---|---|
| list_transactions (limit 50) | 41 ms | 112 ms | 488 ms |
| settlement_summary | 88 ms | 240 ms | 701 ms |
| export_csv | 2.21 s | 4.18 s | 5.93 s |

The list/report endpoints are **DB- and network-bound** (the summary doc
`docs/perf/2026-07-settlement-summary-slow.md` attributes the 3–6 s case to a `HashAggregate`
+ `Seq Scan` on 118k rows, fixed by `shared_buffers`, not by serialization). The export
(2.2 s) is dominated by the DB read + in-memory build, not `JSON.stringify`. The API runs
on **0.5 vCPU / 512 MB with a `max: 5` pool** (`apps/api/src/db/pool.ts:6-8`) — the CPU
budget is small and the pool deliberately caps concurrency, so serialization CPU is not the
bottleneck the load numbers point at. There is no measured evidence that `JSON.stringify`
on these small DTO lists is a meaningful fraction of latency.

### 3.3 The competing JSON-in-Postgres lane already removes the set for the big cases

The endpoints where a whole set is materialized in JS just to be re-aggregated
(archive/replay, batch replay) are **already owned by `docs/design/json-in-postgres-vs-app.md`**
and will move into SQL. The remaining read endpoints (A–E) are all **small, bounded lists**
(`LIMIT 25/100/200/500`, or a single object). For those, the number of rows is small enough
that the per-row allocation `pg`→DTO→stringify is cheap; a hand-rolled buffer writer
replacing it saves little absolute time and adds a large correctness surface (JSON escaping,
date re-render, money formatting, key constants) that must be kept in lockstep with the
existing serializers.

## 4. Where it *would* pay — and the one honest candidate

The optimization is only worthwhile where **all** of these hold:

1. The response is a **large, repeated list** (so per-row savings multiply);
2. Most columns are **JSON-safe text** (no date/money/escaping transforms), or the transforms
   are cheap and already string-shaped;
3. The endpoint is **not** a candidate for the SQL `jsonb_agg` lane (i.e. it must stay in JS);
4. There is a measured serialization cost to attack.

Scanning the repo, **no current endpoint satisfies all four.** The closest is the
transaction report (B, `LIMIT 500`, mostly string columns) — but its two money columns go
through `formatBhd`/`toFils` (frozen `packages/money`), and its `occurred_at` is a
re-rendered date. The transaction list (A) is `LIMIT 100` and DB-bound. The analytics
endpoints (C) are `LIMIT 200` or rollup-backed. **None is large enough or string-only enough
to justify the hand-rolled writer.**

**Conclusion: the optimization is possible but not worth building in this repo today.** The
honest recommendation is a **"no"** — with the cheaper, lower-risk alternative below
capturing most of the theoretical benefit.

## 5. What we will do instead (the cheaper alternative that captures the benefit)

If the goal is "stop paying `JSON.stringify` on DTO objects," the standard Fastify-native
answer is **response schemas + `fast-json-stringify`** — a compiled, schema-driven serializer
that is typically **2–5× faster than `JSON.stringify`** and requires no hand-rolled buffer
writer, no `pg` type-parser surgery, and no duplicated JSON-escaping logic. It is the
industry-standard way to make Fastify serialization fast, and it is *not* currently used
anywhere in this repo (finding 2.1).

**Plan (implementation lane, separate from this one):**

- **Step 1 — pick the first endpoint.** `GET /v1/transactions` (A) is the highest-traffic
  read (`list_transactions` = 20 VUs in fp-209). Add a Fastify **response schema** for its
  200 shape (`transactions: TransactionDto[]`, `nextCursor: string | null`) in
  `apps/api/src/routes/transactions.ts`. Fastify compiles it to `fast-json-stringify` and
  uses it in place of `JSON.stringify` for that route. Verify: `routes/transactions.test.ts`
  green; `curl -i` the live endpoint and confirm the body is byte-identical to the pre-change
  response (same key order, same value rendering).
- **Step 2 — extend to the other read routes** (reporting report B, analytics C) with their
  DTO schemas, one route at a time, each verified by its existing test file + a real-surface
  `curl` diff against the pre-change body.
- **Step 3 — measure.** Re-run the fp-209 k6 scenarios and record p50/p95 for
  `list_transactions` against the published baselines (41 ms / 112 ms). The pass condition is
  **no regression**; any measured win is a bonus. If the numbers are flat (likely, since the
  endpoint is DB-bound), stop — the change is still a correctness-neutral simplification that
  removes a known `JSON.stringify` cost, but it is not a latency fix and should be labeled as
  such.
- **Step 4 — full-suite gate** (repo's own `AGENTS.md`):
  ```
  bun test && cd apps/settlement && go test ./...
  ```
  plus `bun check` (or `tsc --noEmit`) on the changed files.

**Safety / stop conditions for the implementation lane:**
- Stop and revert if any existing test fails because the response **shape** changed — the
  DTO field names, `amountFils`/`capturedFils` as numbers, `occurredAt`/`createdAt` as
  ISO-8601 strings, and `nextCursor` encoding must match current behavior exactly. The
  serializer contract in `serialize.ts` is the source of truth; the schema must mirror it,
  never redefine it.
- The schema must **not** introduce any rounding, precision, or date-rendering change —
  money stays `Number` (fils) / `formatBhd` (report), dates stay `.toISOString()`.
- No change is verified by a passing test alone; each gets a real-surface `curl` diff.

## 6. What we will NOT do (stated so nobody "helpfully" implements the raw idea)

- **No hand-rolled JSON buffer writer** reading raw `pg` column bytes. It re-implements
  `JSON.stringify` (escaping, date re-render, key constants), duplicates the DTO contract,
  and bypasses `pg`-types' tested parsing — for no measured win on endpoints that are
  DB-bound and small.
- **No `rowMode: 'array'` / custom type-parser surgery** on the shared pool. It would change
  the shape of every `result.rows` consumer in the app (`pool.ts` is shared; `result.js`
  `rowAsArray` flips all rows to arrays), a cross-cutting change with no measured benefit.
- **No moving money formatting into the buffer writer.** `formatBhd`/`toFils` stay in
  `packages/money` (frozen); the report path's BD-string rendering is validated there.
- **No `binary: true` protocol flip.** `pg`'s binary mode changes every type parser and is
  a large, risky change for zero measured gain on these endpoints.
- **No overlap with the JSON-in-Postgres lane.** Archive/replay/batch-replay (F) belong to
  `docs/design/json-in-postgres-vs-app.md`; this lane does not touch them.

## 7. ADR note

If the team wants the "Fastify response schemas are the serialization-optimization lever;
raw column-byte buffer assembly is not" rule made durable, add it as an ADR
(`docs/adr/0008-response-serialization-strategy.md`) following the existing pattern. Not
required to implement — recommended to prevent this exact question from being re-argued
on the next perf pass.