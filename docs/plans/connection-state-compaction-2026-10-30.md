# Plan: compact data structures for connection state in FilsPay

> Placement note: this plan lives at `docs/plans/` per the planning-lane
> contract, next to its siblings `io-uring-optimization-2026-10-30.md`,
> `idle-connection-shedding-2026-10-30.md`,
> `server-nginx-tuning-2026-10-30.md`, and `db-query-retention-2026-10-30.md`.
> The orchestrator may relocate it later.

| | |
|---|---|
| **Author** | AI planning lane (connection-state compaction), coordinated with the idle-connection-shedding and nginx lanes |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY. Nothing here is implemented. No file outside `docs/plans/` is touched by this lane. |
| **Verdict** | **NOT-APPLICABLE-TODAY** (the repo owns zero per-connection data structures to compact) |
| **Audience** | The orchestrator deciding whether this deserves a lane, and the implementer who might later add live dashboard connections |

This is the *how-we-will-do-it* document for "compact data structures for
lightweight connection state". It inventories every surface in the repo that
could hold connection state, checks each one against the working tree at HEAD
`7fd7a95`, and reaches an honest answer before any design work: there is
nothing app-owned to compact today. The design in section 3 exists only for
the day live connections are actually added.

---

## TL;DR: the honest answer first

**NOT-APPLICABLE-TODAY.** Every byte of connection state in FilsPay lives
inside a library or runtime (`pg`, `pgx`/`puddle`, `node:http`, `net/http`,
the browser) or in Postgres. App code owns handles, singletons, and booleans,
nothing keyed by connection. Compact representations shrink app-owned
registries, and no registry exists.

The evidence, in one line per claim:

- The API pool is a `pg.Pool` handle with at most 5 sockets, created once
  (`apps/api/src/db/pool.ts:16-20`, `apps/api/src/config.ts:202`,
  `apps/api/src/index.ts:12`). The sockets and their buffers belong to `pg`.
- The reporting pool is the same shape, also capped at 5
  (`apps/reporting/src/db/pool.ts:13-15`, `apps/reporting/src/config.ts:43`).
- The settlement pool is `pgxpool` internals behind one app handle
  (`apps/settlement/internal/db/pool.go:22-32`,
  `apps/settlement/internal/config/config.go:81`).
- Each LISTEN surface is exactly one pinned `pg.Client`
  (`apps/api/src/webhooks/dispatcher.ts:300`,
  `apps/reporting/src/consumer/listener.ts:44`). One instance is not a
  registry.
- Inbound HTTP sockets live in `node:http` inside Fastify
  (`apps/api/src/app.ts:42`, `apps/api/src/index.ts:23`) and in `net/http` in
  Go (`apps/settlement/internal/internalapi/server.go:136-143`). App source
  sets no `keepAliveTimeout`, `getConnections`, or `maxConnections` anywhere
  (zero-match grep in the appendix).
- The frontends hold no sockets at all. The only transport is a per-request
  `fetch` (`apps/web/src/api/client.ts:40`,
  `apps/admin/src/api/client.ts:42`), and the Overview page polls every 60 s
  on purpose (`apps/web/src/pages/overview/OverviewPage.tsx:11-14,62`).
- The whole platform runs in a 512 MB API container on a 0.5 vCPU box
  (`ops/README.md:68-69`) and FP-209 measured 171 MB idle, 236 MB peak
  (`docs/perf/fp-209-loadtest-2026-09.md:44-45`). There is no memory pressure
  to answer.

Verdict per surface, which is the table an implementer should read first:

| Surface | Verdict | Why |
|---|---|---|
| `apps/api` pg pool | **no-op** | Library-owned sockets; `max: 5` is deliberate and owned by the idle-shedding lane (`docs/plans/idle-connection-shedding-2026-10-30.md:111-114`) |
| `apps/reporting` pg pool | **no-op** | Library-owned; reporting is a pure DB worker (`apps/reporting/src/index.ts:8-9`) |
| `apps/settlement` pgxpool | **no-op** | Library-owned; Go already packs structs, and the connection set is inside `pgxpool` (`apps/settlement/internal/db/pool.go:32`) |
| LISTEN clients (api + reporting) | **already-compact** | One client each plus three booleans; adding a compact structure would be new state, not smaller state (`apps/reporting/src/consumer/listener.ts:24-25,44-45`) |
| Inbound HTTP sockets | **library-internal** | Owned by `node:http` / `net/http`; app code has no registry (`apps/api/src/app.ts:42`, `apps/settlement/internal/internalapi/server.go:136-143`) |
| Outbound webhook / settlement transport | **already-compact** | Zero persistent state; one transient `AbortController` per call (`apps/api/src/webhooks/transport.ts:35-40`, `apps/api/src/admin/settlementClient.ts:109-114`) |
| Health readiness flag | **already-compact** | One module-scoped boolean (`apps/api/src/health/state.ts:2,8`) |
| Go internal API | **library-internal** | `net/http` owns the sockets; zero `net.Conn`/`sync.Map` matches (`apps/settlement/internal/internalapi/server.go:136-143`) |
| FE dashboards | **no-op** | Zero WebSocket/SSE, one 60 s fetch poll (`apps/web/src/pages/overview/OverviewPage.tsx:11-14,62`) |
| Any future SSE/WS registry | **applicable-if-live-connections-added** | No such code exists today; section 3 is the design for the day it does |

What would change this answer? Exactly one thing: someone adding live,
long-lived client connections (SSE or WebSocket) to a dashboard. Then there
would be an app-owned registry, and section 3 says how to keep it compact from
day one instead of retrofitting a `Map<socket, meta>` later.

One adjacent fact, flagged and then dropped: the acquirer simulator has three
in-memory `Map`s that never get evicted
(`apps/api/src/acquirer/simulator.ts:82-83,93-95`). They are keyed by
idempotency key, not by connection, so they are business state and out of this
question's scope. They are the only unbounded app-owned in-memory registry in
the tree.

---

## 1. What "connection state" is (for a beginner)

Start with what a connection actually is here. When a dashboard tab calls the
API, it opens a TCP socket, sends an HTTP request, and gets a response. With
HTTP/1.1 keep-alive, that socket stays open for a few seconds so the next
request can reuse it. The server has to remember, per socket, things like
"which request is in flight" and "how long has this been idle". The same is
true for the database: the API holds a small pool of sockets to Postgres, and
each pool socket has its own protocol buffers. And on the event path, one
dedicated socket holds a `LISTEN` subscription so Postgres can push a
notification the moment a webhook row lands
(`apps/api/src/webhooks/dispatcher.ts:300,314`). All of that, plus the
per-request timeout state around outbound HTTP calls
(`apps/api/src/webhooks/transport.ts:35-36`), is what "connection state"
means in this repo.

The part people miss is *who owns* each piece. FilsPay owns almost none of it.
The `pg` library owns every socket and buffer in the API's pool
(`apps/api/src/db/pool.ts:10` says so in a comment). `pgxpool` owns the
settlement connections. `node:http` owns the inbound sockets behind Fastify,
and Go's `net/http` owns the settlement API's sockets. The app owns a handle,
a config number, and in two places a single `pg.Client` object. Sessions are
in Postgres on purpose (`apps/api/src/auth/sessions.ts:31,90`), not in memory.
So when someone asks "can we make connection state lighter", the first real
question is not "which data structure", it's "is there any app-owned data
structure at all?" The answer here is no, and that is why this plan says
NOT-APPLICABLE-TODAY instead of inventing a rewrite.

Now the compact patterns themselves. A compact data structure replaces a hash
map of boxed objects with parallel typed arrays indexed by a small integer: a
slot array keyed by `0..N-1`, a struct-of-arrays layout where `lastSeen` lives
in one `Uint32Array` and flags in a bitset, a free list so slots get reused,
and records pooled per connection instead of allocated per event. In
JavaScript that is roughly 16 to 20 bytes per entry versus 100 bytes or more
for an object plus a `Map` entry. Against this repo's surfaces the idea has
nothing to bite on today: the API pool has at most 5 sockets
(`apps/api/src/config.ts:202`), the two LISTEN clients have 1 instance each, and
the health flag is a single boolean (`apps/api/src/health/state.ts:2`). It only
starts to matter if a dashboard opens hundreds or thousands of live streams,
which is exactly the conditional case in section 3.

---

## 2. The surfaces, site by site

Every line below was re-checked against the working tree on 2026-10-30. The
appendix lists the exact commands.

### Site A: database pools (api, reporting, settlement)

| Fact | Evidence |
|---|---|
| API creates one `pg.Pool` at boot, with `max`, `idleTimeoutMillis`, and `connectionTimeoutMillis` from config | `apps/api/src/db/pool.ts:16-20` |
| Defaults: max 5, idle 30 s, connect timeout 5 s | `apps/api/src/config.ts:202,204,205` |
| Pool created once, probed with `SELECT 1` | `apps/api/src/index.ts:12,19` |
| Transaction helper checks out and releases one client | `apps/api/src/db/withTransaction.ts:26,38` |
| Reporting pool is the same shape, max 5 | `apps/reporting/src/db/pool.ts:13-15`, `apps/reporting/src/config.ts:43` |
| Settlement caps `pgxpool` at `PGPoolMaxConns`, default 5 | `apps/settlement/internal/db/pool.go:27-32`, `apps/settlement/internal/config/config.go:81` |
| The connection machinery is a pinned dependency, not our code | `apps/settlement/go.mod:7,14` |

The connection set itself is inside the driver. There is no list, map, or
array in our source that enumerates sockets. The only writable app lever is
the `max` number, and that number is already tuned for the 512 MB budget and
explicitly claimed as a no-change surface by the idle-connection-shedding
lane (`docs/plans/idle-connection-shedding-2026-10-30.md:111-114`).

**Fail-safe check:** `git diff --stat -- apps/api/src/db/pool.ts apps/reporting/src/db/pool.ts apps/settlement/internal/db/pool.go` must be empty for any work attributed to this plan. If `max` or a timeout changed, it came from another lane and needs that lane's review.

### Site B: LISTEN clients (api dispatcher and reporting consumer)

| Fact | Evidence |
|---|---|
| The API creates exactly one non-pooled `pg.Client` for LISTEN | `apps/api/src/webhooks/dispatcher.ts:300` |
| It issues `LISTEN outbox_events_channel` on a channel constant | `apps/api/src/webhooks/dispatcher.ts:33,314` |
| A poll timer is the NOTIFY-loss safety net, and both are cleared on stop | `apps/api/src/webhooks/dispatcher.ts:323,328,331` |
| The reporting consumer creates one pinned client too, with a "DO NOT TOUCH" comment | `apps/reporting/src/consumer/listener.ts:41,44` |
| Its connection state is one boolean, set after connect | `apps/reporting/src/consumer/listener.ts:45,58` |
| Two more booleans dedupe passes (`running`, `stopped`) | `apps/reporting/src/consumer/listener.ts:24-25` |
| A poll timer backs it up | `apps/reporting/src/consumer/listener.ts:73` |
| These clients must never be shed or repurposed | `docs/plans/idle-connection-shedding-2026-10-30.md:122-131` |

One client is not a collection. Re-encoding a single handle saves bytes that
are already negligible, and the incident history here is leaked or duplicated
LISTEN connections, not excess memory (`docs/plans/idle-connection-shedding-2026-10-30.md:128-131`).
If anything, this surface needs *fewer* moving parts, not a new representation.

**Fail-safe check:** `git diff -- apps/api/src/webhooks/dispatcher.ts apps/reporting/src/consumer/listener.ts` must be empty. Any change here is a regression risk against the 2026-05-14 incident class and belongs to nobody in this plan.

### Site C: inbound HTTP sockets (Fastify and Go internal API)

| Fact | Evidence |
|---|---|
| Fastify instance built without listening | `apps/api/src/app.ts:42` |
| Listen happens once at boot | `apps/api/src/index.ts:23` |
| Dispatcher starts explicitly after listen | `apps/api/src/index.ts:25,31` |
| Go builds one `http.Server` with a `BaseContext` and a 10 s header timeout | `apps/settlement/internal/internalapi/server.go:136,142,143` |
| Graceful shutdown is bounded at 30 s | `apps/settlement/internal/internalapi/server.go:44,150` |
| No app-side connection registry or keep-alive tuning exists | zero matches for `getConnections`, `closeIdleConnections`, `keepAliveTimeout`, `maxConnections` across `apps/api/src`, `apps/reporting/src`, `packages/events/src` (appendix) |

Inbound socket count and lifecycle are runtime concerns. The app has no
structure to compact, and the levers that do exist (`keepAliveTimeout`,
`closeIdleConnections`) are claimed by the idle-shedding lane
(`docs/plans/idle-connection-shedding-2026-10-30.md:86-110`) and the nginx
lane (`docs/plans/server-nginx-tuning-2026-10-30.md:334-352`). A representation
rewrite here would mean rewriting `node:http` or `net/http`.

**Fail-safe check:** the same zero-match grep in the appendix must still return exit 1 for `apps/api/src`. If a connection registry appears, it needs its own plan, not an edit inside this one.

### Site D: outbound transports (webhook delivery and settlement client)

| Fact | Evidence |
|---|---|
| Webhook delivery creates one `AbortController` and one timeout per call | `apps/api/src/webhooks/transport.ts:35-36` |
| The socket comes from global `fetch` (runtime-owned), not an app agent | `apps/api/src/webhooks/transport.ts:40` |
| Request timeout defaults to 10 s | `apps/api/src/config.ts:256` |
| Settlement admin calls have the same shape | `apps/api/src/admin/settlementClient.ts:109-110,114` |
| Settlement call timeout defaults to 30 s | `apps/api/src/config.ts:244` |
| Dispatch is sequential, with batch limits of 500 (step A) and 100 (step B) | `apps/api/src/webhooks/dispatcher.ts:23-24` |

Zero persistent outbound connections are app-owned. There is no pool, no
registry, and no socket list, so there is nothing to compact. A persistent
transport pool only pays at real concurrency, and the dispatcher is
deliberately sequential (`apps/api/src/webhooks/dispatcher.ts:23-24`). The
single-container premise that makes this fine is stated in the code
(`apps/api/src/acquirer/simulator.ts:91`) and in the deployment notes
(`ops/README.md:68-69`).

**Fail-safe check:** `rg -c "new AbortController" apps/api/src` must stay at 2 (`apps/api/src/webhooks/transport.ts:35`, `apps/api/src/admin/settlementClient.ts:109`). A third controller means a new outbound path was added without this plan's review.

### Site E: health readiness flag

| Fact | Evidence |
|---|---|
| One module-scoped boolean | `apps/api/src/health/state.ts:2` |
| Set once after the boot probe | `apps/api/src/health/state.ts:4`, `apps/api/src/index.ts:19-20` |
| Read by `/readyz` | `apps/api/src/health/state.ts:8`, `apps/api/src/routes/health.ts:21` |
| Test reset hook is the only other writer | `apps/api/src/health/state.ts:13` |

One byte is already the compact limit. There is no work here.

**Fail-safe check:** the file stays at one boolean variable; `rg -n "let dbConnectedOnce" apps/api/src/health/state.ts` must return exactly line 2.

### Site F: Go settlement internal API

| Fact | Evidence |
|---|---|
| One `http.Server`, routes on a stdlib mux, only under the daemon subcommand | `apps/settlement/internal/internalapi/server.go:120-124,136`, `apps/settlement/cmd/settlement/main.go:85` |
| No `net.Conn`, `sync.Map`, `connInfo`, or `activeConn` anywhere in `apps/settlement` | zero-match grep (appendix) |
| The scheduler is a ticker loop with no "already ran" memory | `apps/settlement/internal/scheduler/daemon.go:39,55-59` |

Go packs structs and `net/http` owns the sockets. There is no app-owned
connection collection, so a compact rewrite has no target. Even the settlement
batch's in-memory maps are keyed by merchant or transaction and released when
the call returns, which is business data, not connection state.

**Fail-safe check:** `cd apps/settlement && go test ./...` stays green, and the zero-match `net.Conn`/`sync.Map` grep must still return exit 1.

### Site G: frontend dashboards

| Fact | Evidence |
|---|---|
| Web and admin clients use per-request `fetch` only | `apps/web/src/api/client.ts:40`, `apps/admin/src/api/client.ts:42` |
| The Overview page polls every 60 s and says "Poll, not push" | `apps/web/src/pages/overview/OverviewPage.tsx:11-14,62` |
| No WebSocket, EventSource, SSE, long-poll, or socket.io in any FE src | zero-match grep (appendix) |
| The admin interval reads localStorage, not the network | `apps/admin/src/auth/AdminAuthContext.tsx:70` |

The browser owns the keep-alive sockets. App JS holds no connection objects,
so there is nothing to compact. The FE surface is a 60 s timer and two
debounce timers, and none of them is connection state.

**Fail-safe check:** `rg -c "new WebSocket|EventSource|eventsource|text/event-stream|server-sent|socket.io" apps/admin/src apps/web/src apps/reporting/src` must still return exit 1.

---

## 3. Implementation plan (for the later, separate lane)

Read the gate first. Nothing in this section should start while the gate is
false.

### 3.0 The gate

Implement only if a real feature adds **live, long-lived client connections**
(SSE or WebSocket) to a dashboard. The current Overview page explicitly does
not (`apps/web/src/pages/overview/OverviewPage.tsx:11-14`), and no FE source
creates one (appendix). If the demo keeps polling, this plan stays closed and
that is the correct outcome, the same way
`.omo/plans/prepare-once-and-connection-reuse.md:14-19` was closed with
evidence rather than a speculative lane.

### 3.1 Allowed write files for the implementing lane

New files only (no collision with any lane):

- `apps/api/src/connections/registry.ts` (new): the compact registry.
- `apps/api/src/connections/registry.test.ts` (new): unit tests for the
  structure, no timers.
- `apps/api/src/routes/live.ts` (new): the SSE (or WS) route that allocates
  a connection slot and streams.
- `apps/api/src/routes/live.test.ts` (new): route-level test.

Existing files, **approval required before touching**:

- `apps/api/src/app.ts`: one `register` line for the live route. The
  idle-connection-shedding lane lists this file in its allowed write set
  (`docs/plans/idle-connection-shedding-2026-10-30.md:139-142`). Sequence
  behind that lane or get its written OK first.
- `apps/api/src/config.ts`: new fields for registry capacity and heartbeat.
  Same collision, same rule: that lane claims this file
  (`docs/plans/idle-connection-shedding-2026-10-30.md:139-142`).
- `apps/web/src/pages/overview/OverviewPage.tsx` plus a new
  `apps/web/src/api/liveClient.ts`: only if the orchestrator approves
  replacing the 60 s poll. This is a product decision, not an optimization.

Explicitly **not** allowed:

- Do not touch pool configuration. `apps/api/src/config.ts:202-205`,
  `apps/reporting/src/config.ts:43`, and
  `apps/settlement/internal/config/config.go:81` are already tuned, and the
  idle-shedding lane owns the pool verdicts
  (`docs/plans/idle-connection-shedding-2026-10-30.md:111-114`). Any proposed
  change to `max`, `idleTimeoutMillis`, or `connectionTimeoutMillis` needs
  that lane's approval in writing, and this plan's default answer is no.
- Do not touch the LISTEN clients, `packages/money`, any test file, the
  `v1/` 501 stubs, or `WEBHOOK_ELIGIBLE_EVENT_TYPES`.

### 3.2 The compact registry design (only for the SSE/WS case)

The shape, concretely, for a 512 MB container:

- **Integer-keyed slot array.** A connection slot is an index into parallel
  typed arrays, not an object in a `Map`. A free list (an `Int32Array` stack)
  recycles slots, and a generation counter makes stale client ids
  distinguishable from recycled ones. The wire handle is
  `(generation << 16) | slot`.
- **Struct-of-arrays layout.** Four arrays do the work:
  - `merchantIndex: Uint16Array` (index into a small interned merchant table,
    because merchant ids are UUIDs and should not be stored per connection),
  - `lastSeenSec: Uint32Array` and `expiresAtSec: Uint32Array` (epoch seconds,
    the same integer-time style the repo already uses for session TTLs,
    `apps/api/src/config.ts:207-208`),
  - `flags: Uint8Array` (one bit each for "waiting for drain", "has pending
    event", "closing").
- **Bitset liveness.** One bit per slot in a `Uint8Array`, so a sweep checks
  32 slots per word instead of chasing object pointers. Cleared on free,
  set on allocate.
- **Pooled records.** The per-event payload object is reused per slot (a
  ring of N records), so a steady 1000-connection demo allocates nothing per
  event after warmup. The registry itself owns no timers and no sockets; it
  stores ids and flags, and the transport layer owns writing bytes.
- **Bounded capacity.** Default capacity 1024, env-set, and allocation fails
  closed (reject new streams with 503) rather than growing without bound.
  At roughly 16 to 20 bytes per slot, 1024 slots is tens of KB.

A sketch of the allocation core, close enough to review:

```ts
// apps/api/src/connections/registry.ts (new)
export interface Registry {
  allocate(merchantIndex: number, nowSec: number): number | null;
  free(handle: number): void;
  touch(handle: number, nowSec: number): void;
  isLive(handle: number): boolean;
}
// slot -> index into merchantIndex/lastSeenSec/expiresAtSec/flags
// handle = (generation << 16) | slot
```

If a future version needs reconnect grace, the grace period is a column
(`graceUntilSec: Uint32Array`), not a per-connection object.

**Implementation order** (do not reorder without saying why in the PR):

1. `registry.ts`: allocate, free, touch, liveness bitset, free list, and
   generation counter. Pure data structure, no I/O.
2. `registry.test.ts`: exhaust capacity, recycle, stale-handle rejection,
   bitset sweep. No timers, no sleeps; the tests pass a `nowSec` argument.
3. `live.ts`: the SSE route. Subscribe the writer to the registry slot
   *before* starting the stream, so an event fired immediately after
   allocation cannot be lost.
4. `live.test.ts`: inject a `Fastify` instance, open one connection, push one
   event, assert one ordered frame. No fixed sleeps; await the stream's
   `data` event with a bounded timeout.
5. Wire the route in `app.ts` and the config fields, after coordination with
   the idle-shedding lane (section 3.1).
6. Only then, if approved, the FE client and the Overview page.
7. Update the idle shedder's high-water if it exists by then. Its config is
   the only place that should know about connection counts
   (`docs/plans/idle-connection-shedding-2026-10-30.md:147-160`).

**Tests that must exist:**

- capacity exhaustion returns `null` and does not grow;
- `free` then `allocate` reuses the slot and the old handle fails
  `isLive`;
- the bitset sweep visits exactly the live slots;
- an SSE client receives events in order;
- disconnecting frees the slot (assert via the registry, not via timing).

**Verification commands** (see section 6 for the full table):

```
bun test
bun run typecheck
cd apps/settlement && go test ./...
```

Only the first two are relevant unless the settlement service is touched, in
which case the Go suite is mandatory per `AGENTS.md:89`.

### 3.3 Pooled outbound transports (lower priority, same gate)

Only if outbound webhook or settlement volume stops being sequential. The
design would be a slot array of transport records keyed by endpoint index,
with a busy/free bitset, replacing the per-call `AbortController` at
`apps/api/src/webhooks/transport.ts:35-36`. The precondition is real
concurrency: today dispatch is sequential
(`apps/api/src/webhooks/dispatcher.ts:23-24`), so a pool would be dead weight.
If it ever lands, it must not change the LISTEN lifecycle and must not touch
the pool configs in section 3.1.

---

## 4. What this lane will NOT do

- **It does not implement.** This file is the only artifact. No source, test,
  config, or migration is edited, and the implementation is a separate lane.
- **It does not overlap the idle-connection-shedding lane.** That lane owns
  the lifecycle and timers: `keepAliveTimeout`, `getConnections`, and
  `closeIdleConnections` on the API server
  (`docs/plans/idle-connection-shedding-2026-10-30.md:86-110,137-206`). This
  plan must not add, remove, or retune those.
- **It does not overlap the nginx lane.** Proxy keep-alive, timeouts, and
  buffering belong to `server-nginx-tuning-2026-10-30.md` (`:181-270`), and
  the Fastify `keepAliveTimeout`/`trustProxy` edits are explicitly handed to
  an implementer there (`docs/plans/server-nginx-tuning-2026-10-30.md:334-352`).
- **It does not overlap the io_uring lane.** Runtime and syscall behavior is
  theirs (`docs/plans/io-uring-optimization-2026-10-30.md:95-110`). Sockets
  stay runtime-owned either way.
- **It does not touch pool configs.** See section 3.1: another lane tuned
  them and this plan's default is no.
- **It does not touch `packages/money` or the Go mirror.** Frozen by
  `AGENTS.md`, and nothing here is monetary anyway.
- **It does not edit tests.** Existing tests are regression-locked by
  `AGENTS.md`. The only new test files are the ones named in section 3.1.
- **It does not touch the `v1/` 501 stubs or `WEBHOOK_ELIGIBLE_EVENT_TYPES`.**
  `AGENTS.md` forbids both, and neither is connection state.
- **It does not add a connection registry speculatively.** No live
  connections exist today (site G), so shipping the registry now would be
  dead code and a new place for bugs.

Write scope of this lane: `docs/plans/connection-state-compaction-2026-10-30.md`
only. Anything else is out of scope and a defect.

---

## 5. Coordination with the in-flight lanes (disjoint scopes)

| Lane | Owns | This plan's touchpoint there |
|---|---|---|
| batch-commit (`.omo/plans/batch-committing.md`) | `apps/settlement/internal/settlement/{batch,allocate,payout_notify}.go` and its tests | None. A connection registry does not change commit batching, and this plan does not touch the settlement pass |
| JSON-in-Postgres (`docs/design/json-in-postgres-vs-app.md`) | `apps/api/src/webhooks/archiveReplay.ts`, `replayBatch.ts`, set-based SQL in the dispatcher and reporting consumer | None. Reads only; the LISTEN clients stay as they are |
| io_uring (`docs/plans/io-uring-optimization-2026-10-30.md:95-110`) | seccomp, Postgres 18, Bun runtime | None on files. If the runtime ever owns socket readiness differently, the registry design still works because it stores ids, not sockets |
| nginx (`docs/plans/server-nginx-tuning-2026-10-30.md`) | proxy keep-alive, timeouts, sysctl, host Postgres tuning | None on files. Its Fastify `keepAliveTimeout` edit (`:334-352`) is a lifecycle lever, not a representation one |
| idle-connection-shedding (`docs/plans/idle-connection-shedding-2026-10-30.md`) | `apps/api/src/config.ts`, new `plugins/connectionShedding.ts`, one `app.ts` register line | Shared files: `app.ts` and `config.ts` are in its write set (`:139-142`). This plan sequences behind it and asks for approval before those two lines. Liveness bits are readable by the shedder but the shedder stays the owner of shedding |
| db-query-retention (`docs/plans/db-query-retention-2026-10-30.md`) | `transaction_events` index, `outbox_events` retention | None. Its tables are not touched by connection state |

The one real coordination cost is `app.ts` and `config.ts`: two lines in each,
already claimed. That is why the implementation order puts the pure registry
and route first and the wiring last.

---

## 6. Verification steps (for the implementing lane)

Run from the repo root unless noted. `AGENTS.md:89` gives the convention
`bun test && cd apps/settlement && go test ./...`.

| Check | Command | PASS observable |
|---|---|---|
| Typecheck | `bun run typecheck` (`package.json:11`) | Exit 0, no diagnostics |
| Root tests | `bun test` (`AGENTS.md:89`) | All green, including the new registry and route tests |
| API package tests | the script in `apps/api/package.json:9` (it runs `tsx --test`, not `bun test`) | All green under the package's own runner too |
| Settlement tests | `cd apps/settlement && go test ./...` (`AGENTS.md:89`) | Green; skip with `-short` only on Windows per `AGENTS.md:43` |
| No pool drift | `git diff --stat -- apps/api/src/db/pool.ts apps/reporting/src/db/pool.ts apps/settlement/internal/db/pool.go` | Empty |
| No LISTEN drift | `git diff -- apps/api/src/webhooks/dispatcher.ts apps/reporting/src/consumer/listener.ts` | Empty |
| Registry behavior | the new `registry.test.ts` | Capacity, recycling, stale handles, bitset sweep all pass without sleeps |
| Live route behavior | the new `live.test.ts` | One connection receives one ordered frame; disconnect frees the slot |

Per the test discipline in this environment: no fixed sleeps in the new tests.
For the SSE case, subscribe to the stream's data event before triggering the
push, then await it with a bounded timeout.

---

## 7. Risks and fail-safes

- **Inventing work that isn't there.** The biggest risk is shipping a
  registry for a platform that still polls every 60 s. Failure mode: dead
  code with its own bugs. Fail-safe: the gate in section 3.0, and the
  precedent of `.omo/plans/prepare-once-and-connection-reuse.md:14-19`.
- **Collision with the idle-shedding lane.** Both would touch `app.ts` and
  `config.ts`. Fail-safe: sequence behind that lane, or get its written OK;
  never edit those files in the same branch.
- **A registry that becomes the new leak.** Unbounded slot growth on
  disconnect bugs is exactly the old `Map<socket, meta>` failure. Fail-safe:
  fixed capacity, allocate-fails-closed, and a test that disconnect frees the
  slot.
- **Liveness drift.** A bitset that disagrees with the real socket state
  makes the shedder wrong. Fail-safe: one writer for the bit (the route's
  close handler), and the shedder reads only.
- **Memory pressure that doesn't exist.** FP-209 measured 236 MB peak against
  a 512 MB cap (`docs/perf/fp-209-loadtest-2026-09.md:44-45`). Fail-safe: no
  optimization here without a measured regression first.

---

## 8. Open questions (for the orchestrator, not blockers for this document)

1. **Will the demo add dashboard live-updates?** If the answer is no, this
   plan stays NOT-APPLICABLE and should be closed the way
   `prepare-once-and-connection-reuse.md` was.

2. **Is a connection registry even wanted?** The current 60 s poll
   (`apps/web/src/pages/overview/OverviewPage.tsx:62`) handles the dashboard
   fine at this scale. Live updates are a product feature, not an
   optimization; the orchestrator should decide it as a product question.

3. **Should this stay P3/no-op in the backlog, or be recorded as rejected?**
   The evidence supports closed. Recording it as rejected with this document
   as the reason prevents a future agent from "helpfully" adding a registry.

4. **If live connections land, who owns the FE half?** Replacing the poll in
   `OverviewPage.tsx` is a UI change with its own review needs, and this plan
   does not assign that owner.

5. **If a registry lands, does it merge into the idle shedder's plugin or
   stay separate?** One source of truth for liveness is cleaner, but it
   couples the two lanes. Default recommendation: separate module, read-only
   view for the shedder.

---

## Appendix: citation re-verification (2026-10-30)

Every line in this document was checked against the working tree at HEAD
`7fd7a95` before writing. Commands run from the repo root:

```
grep -n "new Pool\|max: config.pgPoolMax\|idleTimeoutMillis\|connectionTimeoutMillis" apps/api/src/db/pool.ts   # 16,18,19,20
grep -n "pgPoolMax\|pgPoolIdleTimeoutMs\|pgPoolConnectionTimeoutMs" apps/api/src/config.ts                     # 202,204,205
grep -n "new Client\|LISTEN \${NOTIFY_CHANNEL}\|setInterval\|listenClient.end" apps/api/src/webhooks/dispatcher.ts  # 300,314,323,331
grep -n "AbortController\|setTimeout\|fetch(req.url" apps/api/src/webhooks/transport.ts                         # 35,36,40
grep -n "let dbConnectedOnce\|isReady" apps/api/src/health/state.ts                                             # 2,8
grep -n "new Pool\|max:" apps/reporting/src/db/pool.ts                                                          # 13,15
grep -n "new Client\|listenClientConnected\|setInterval" apps/reporting/src/consumer/listener.ts                 # 44,45,73
grep -n "MaxConns\|pgxpool.NewWithConfig" apps/settlement/internal/db/pool.go                                   # 28,32
grep -n "http.Server{\|ReadHeaderTimeout\|ListenAndServe" apps/settlement/internal/internalapi/server.go        # 136,143,158
grep -n "POLL_MS\|window.setInterval" apps/web/src/pages/overview/OverviewPage.tsx                              # 14,62
grep -n "fetch(\`" apps/web/src/api/client.ts apps/admin/src/api/client.ts                                      # web:40, admin:42
grep -n "512\|0.5 vCPU" ops/README.md                                                                           # 68,69
grep -n "RSS at idle\|RSS peak" docs/perf/fp-209-loadtest-2026-09.md                                            # 44,45
```

Zero-result checks (all returned exit 1, no matches):

```
rg -c "new WebSocket|EventSource|eventsource|text/event-stream|server-sent|socket.io" apps/admin/src apps/web/src apps/reporting/src
rg -c "getConnections|closeIdleConnections|keepAliveTimeout|maxConnections" apps/api/src packages/events/src apps/reporting/src -g "*.ts"
rg -c "net\.Conn|sync\.Map|connInfo|activeConn" apps/settlement apps/reporting/src
```

Scope honored: this lane read only the three inventory handoffs, the
feasibility verdict, the sibling plans, and the repo files cited above. It
created only this file.
