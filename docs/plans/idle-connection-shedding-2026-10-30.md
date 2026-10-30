# Plan: dynamically shedding idle connections in FilsPay

> Placement note: this plan lives at `docs/plans/` per the planning-lane contract
> (same as the siblings `io-uring-optimization-2026-10-30.md`,
> `server-nginx-tuning-2026-10-30.md`, `db-query-retention-2026-10-30.md`). It is
> the **how-we-will-do-it** document for the "dynamically shed idle connections"
> optimization. It changes **no code**; the implementation is a separate, later lane.

| | |
|---|---|
| **Author** | AI planning lane (connection shedding), coordinated with the nginx-tuning lane |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — nothing here is implemented. No file outside `docs/plans/` is touched by this lane. |
| **Runtime basis** | Bun 1.4.4 (this session's kernel; compose runs `["bun", "apps/api/src/index.ts"]`, `ops/docker-compose.yml`); Fastify 5.12.3; `pg` ^8.13.1 |

---

## TL;DR — the honest answer first

**Yes, "dynamically shedding idle connections" is possible — and the surprising
finding is that half of it is already built into the runtime.** Per surface:

| Surface | Verdict | One-line reason |
|---|---|---|
| Inbound HTTP keep-alive sockets (`apps/api` Fastify server) | **POSSIBLE — the one new lever** | Runtime already drops idle keep-alive after 5 s (`keepAliveTimeout`); nothing tunes it today, and an adaptive shedder (`closeIdleConnections()` when connection count/RSS exceeds a high-water mark) is implementable as a small Fastify plugin — every mechanism probed working on Bun 1.4.4 this session (§2, §6). |
| Postgres pool idle clients, `apps/api` | **ALREADY DYNAMIC — no code needed** | `pg.Pool` sheds idle clients on a timer: `idleTimeoutMillis` 30 s set explicitly (`apps/api/src/db/pool.ts:19-20`, default `config.ts:204`), `max: 5` caps memory for 0.5 vCPU/512 MB (§2). |
| Postgres pool idle clients, `apps/reporting` | **ALREADY DYNAMIC — no code needed** | Pool sets no `idleTimeoutMillis` → `pg` default 10 s applies (`node_modules/pg-pool/index.js:98-99`); reporting is a background worker, no HTTP at all (`apps/reporting/src/index.ts`). |
| LISTEN/NOTIFY clients (webhook dispatcher, reporting consumer) | **DO NOT SHED** | Long-lived by design; the historical failure mode was *leaked/duplicated* LISTEN connections (FP-209, #398), the opposite of shedding (§4). |
| Outbound webhook / settlement / acquirer connections | **Out of scope — negligible** | Low volume; per-attempt request timeouts already exist (`webhookRequestTimeoutMs` 10 s default, `config.ts:256`; `settlementClient.ts:110`). |
| Upstream keep-alive (Cloudflare → origin nginx) | **Owned by the nginx lane** | `docs/plans/server-nginx-tuning-2026-10-30.md` §1/Addendum; an app-side shedder must not fight the proxy's pooled upstream connections (§5). |

**Bottom line.** The optimization decomposes into: (1) an **adaptive HTTP
keep-alive shedder** on `apps/api` — feasible, small (±100 lines), low risk, and
**(2) nothing to do for the pools**, which already shed on pg's own timer.
Expected gain is modest and conditional. FP-209 evidence (`docs/perf/fp-209-loadtest-2026-09.md`)
shows the API at idle RSS 171 MB / peak 236 MB of a 512 MB cap and passing load with
28 concurrent VUs — idle sockets are not the current bottleneck. The shedder earns
its keep under **connection spikes** (demo day with many dashboard tabs, a k6 run,
a misbehaving client holding sockets open), where it protects memory, FDs
(`ulimit -n` in the container), and fails over faster after a proxy/DNS change.
Recommendation: implement it env-gated and **off by default**, measure, then
promote — it is insurance, not a throughput win.

---

## 1. What an "idle connection" is here (two paragraphs for a beginner)

Every HTTP client that talks to the API (a merchant dashboard tab, a k6 load-test
worker, or the nginx/Cloudflare proxy in front of the container) opens a TCP
socket. After the response is sent, HTTP/1.1 keep-alive keeps that socket open for a
few seconds so the next request can reuse it instead of paying the TCP+TLS setup
cost again. An **idle connection** is one such socket that has finished its last
request and is just waiting — it costs the process a file descriptor and some socket
buffer memory while it waits, and it adds up if thousands of them accumulate.

Every server runtime bounds that wait with a *keep-alive timeout*: when a socket is
idle longer than that, the server closes it itself. Node's default is 5
seconds, and this plan's probe confirmed Bun's `node:http` (which Fastify runs on)
ships the same default plus a `server.closeIdleConnections()` API that closes *all*
currently-idle keep-alive sockets on demand. **"Dynamically" shedding** means:
instead of only the fixed 5 s timer, the app actively samples how many connections
it is holding and sheds idle ones when that count (or memory pressure) passes a
threshold — a slow ramp-up in normal operation, an aggressive clamp under a spike.

---

## 2. Surface inventory with file:line evidence

All line numbers verified against the working tree on 2026-10-30. This lane only
read these files.

| # | Surface | Evidence | Current behavior |
|---|---|---|---|
| A | HTTP server, `apps/api` | `app.ts:42` `Fastify({ logger: true })` — **no server options**; `index.ts:23` `app.listen({ port, host: "0.0.0.0" })`; pool created once `index.ts:12`, dispatcher started after listen `index.ts:31` | Node/Bun defaults: `keepAliveTimeout` 5000 ms, `headersTimeout` 60000 ms, `requestTimeout` 300000 ms, socket `timeout` 0 (probed, §6 P1). **No tuning anywhere** in `ops/`, `apps/`, `packages/` (rg 2026-10-30: zero hits for `keepAliveTimeout`/`closeIdleConnections`/`maxConnections`). |
| B | pg pool, `apps/api` | `apps/api/src/db/pool.ts:16-20` (`max`, `idleTimeoutMillis`, `connectionTimeoutMillis`); config defaults `config.ts:203-205` (`PG_POOL_MAX` 5, `PG_POOL_IDLE_TIMEOUT_MS` 30_000, `PG_POOL_CONNECTION_TIMEOUT_MS` 5_000) | pg sheds idle clients after 30 s; `max: 5` intentional for 0.5 vCPU/512 MB (pool.ts comment). `pgPoolMin` (`config.ts:16`, `:203`) is parsed but **never passed to the Pool** — vestigial config (cleanup note, §5). |
| C | pg pool, `apps/reporting` | `apps/reporting/src/db/pool.ts:15` (`max` only); `apps/reporting/src/config.ts` `pgPoolMax` default 5 | No `idleTimeoutMillis` → pg default **10 s** (`node_modules/pg-pool/index.js:98-99`). Reporting is a pure background worker — **no HTTP server, no keep-alive surface** (`apps/reporting/src/index.ts`). |
| D | LISTEN clients | `apps/api/src/webhooks/dispatcher.ts:300-314` (dedicated `Client`, `LISTEN outbox_events_channel`; started explicitly after `app.listen`, `:274-279`); `apps/reporting/src/consumer/listener.ts` (dedicated `Client`, `"LISTEN needs a pinned connection. DO NOT TOUCH"` comment) | Long-lived by design — near-real-time event delivery. **Not idle to shed.** |
| E | Outbound calls | `apps/api/src/admin/settlementClient.ts:110` (abort timer), `config.ts:244`/`:256` timeouts; dispatcher transport `webhooks/transport.ts` / `testSend.ts:63` | fetch-based, per-call timeouts; Bun's fetch has its own short-lived pooling. Negligible steady-state impact. |
| F | Reverse proxy | `ops/docker-compose.yml` (api published to `0.0.0.0:3000`, no proxy locally); deployed topology **browser → Cloudflare → origin nginx → containers** (`docs/plans/server-nginx-tuning-2026-10-30.md` Addendum §2) | nginx owns upstream keep-alive there; not removable (§5). |
| G | Perf baseline | `docs/perf/fp-209-loadtest-2026-09.md` (28 VUs, 10 min: export p50 2.21 s, list p50 41 ms, peak RSS 236 MB, 0 errors) | API holds the load at 512 MB with no connection tuning; Sept 15 restarts coincided with **DB connection errors** (dispatcher "Connection terminated unexpectedly", #398 LISTEN leaks), not memory or sockets. |

---

## 3. Feasibility verdict per surface

### A — Inbound HTTP keep-alive: **feasible, verified, low risk**

Every mechanism the optimization needs was probed working under the repo's
runtime this session (§6 P1–P3, Bun 1.4.4 + installed Fastify 5.12.3):

- `http.Server` exposes `keepAliveTimeout` (default 5000, settable), plus
  `closeIdleConnections()` / `closeAllConnections()` and `getConnections()`.
- Fastify forwards server options (`keepAliveTimeout`, `connectionTimeout`,
  `requestTimeout`, `maxRequestsPerSocket` — `node_modules/fastify/fastify.d.ts:126-130`).
- Behaviorally: three keep-alive sockets that each completed one request counted 3
  via `server.getConnections()`; one `server.closeIdleConnections()` call took them
  to 0. **A Node-side guarantee worth leaning on: `closeIdleConnections()` only
  touches sockets with no in-flight request — busy connections are never cut.**

Trade-offs to design around:
- **Don't fight the proxy.** Behind Cloudflare, the origin nginx pools its own
  upstream connections; shedding down to 0 constantly would force reconnect churn
  at nginx and add latency, not remove it. Hence the *adaptive* shape: shed only
  when measurements say there is pressure. Aggressive static `keepAliveTimeout`
  values (< ~1 s) are exactly the anti-pattern to avoid; the static-options
  alternative is compared in §4 Site A (why dynamic beats static).
- **Gain is bounded.** Each idle socket costs one FD + small socket buffers; the
  win shows under spikes (many simultaneous dashboard tabs during a demo, a k6
  ramp, a stuck client), not in FP-209-style steady load.

### B/C — Postgres pools: **already dynamic; no new work**

`pg` closes idle clients itself after `idleTimeoutMillis` (api: 30 s explicit,
reporting: 10 s default) and grows/shrinks on demand up to `max`. "Dynamically
shedding DB connections" is therefore already the library's default behavior, and
the pools are intentionally tiny (`max: 5`) for the 0.5 vCPU budget. **Tuning
`idleTimeoutMillis` down would only churn connections against Postgres
`max_connections`; tuning it up saves nothing (idle clients hold buffers, not
locks).** The only real finding is `pgPoolMin` being dead config — a cleanup, not
an optimization (§5).

### D — LISTEN clients: **must not be shed**

The dispatcher (`dispatcher.ts:300`) and reporting consumer (`listener.ts`) run on
pinned LISTEN connections so event delivery is near-real-time. The evidence says
the failure mode here is *too few / duplicated* connections, never too many idle
ones: FP-209's postmortem blames the Sept 15 restarts on dispatcher "Connection
terminated unexpectedly" and #398's reporting-worker LISTEN *leak*. Shedding
these would re-create the incident, not prevent it. The poll-fallback timers
(`webhookPollIntervalMs` 5 s, `reportingPollIntervalMs` 15 s) would eventually
cover a lost LISTEN, but at the cost of latency and the known incident class.

### E — Outbound: **out of scope**. F — Proxy: **owned by the nginx lane**.

---

## 4. Implementation plan (for the later, separate lane)

Allowed write files for the implementation lane — **nothing else**:
`apps/api/src/config.ts`, `apps/api/src/plugins/connectionShedding.ts` (new),
`apps/api/src/app.ts` (one `register` line), new test file
`apps/api/src/plugins/connectionShedding.test.ts` **(do not touch `app.test.ts` or
any other file another lane has open — as of 2026-10-30 the shared working tree has
`apps/api/src/app.test.ts`, `webhooks/dispatcher.test.ts`, `db/migrate.ts`, the
settlement Go tests, etc. modified by other lanes)**.

### Site A — adaptive connection-shedding plugin on `apps/api`

**1. Config (`apps/api/src/config.ts`)** — new fields in `Config` +
`loadConfig`, following the existing `parseIntEnv` pattern:

| Field | Env var | Default | Meaning |
|---|---|---|---|
| `httpKeepAliveTimeoutMs` | `HTTP_KEEPALIVE_TIMEOUT_MS` | `5000` | Baseline keep-alive timeout (keep the runtime default). |
| `httpShedHighWaterConnections` | `HTTP_SHED_HIGH_WATER_CONNECTIONS` | `0` (= **disabled**) | Total live connections at which shedding starts. |
| `httpShedLowWaterConnections` | `HTTP_SHED_LOW_WATER_CONNECTIONS` | `min(highWater/2, 100)` | Hysteresis: below this, the shed rate returns to normal. |
| `httpShedCheckIntervalMs` | `HTTP_SHED_CHECK_INTERVAL_MS` | `10_000` | Sampler period. |
| `httpShedRssBytes` | `HTTP_SHED_RSS_BYTES` | `0` (= disabled) | Alternative trigger: shed idle sockets when `process.memoryUsage().rss` exceeds this (e.g. set 350_000_000 inside the 512 MB cap). |

**2. Plugin (`apps/api/src/plugins/connectionShedding.ts`, new)** — registered in
`buildApp` (`app.ts`, after the existing `plugins` registers), with these behaviors:

- `onReady`: apply `app.server.keepAliveTimeout = config.httpKeepAliveTimeoutMs`
  (verified settable, §6 P1).
- `setInterval` sampler (period `httpShedCheckIntervalMs`): read
  `app.server.getConnections(...)`. When `count > highWater` **or**
  `rss > httpShedRssBytes`:
  - call `app.server.closeIdleConnections()` (verified working, §6 P3) —
    **only affects idle sockets, never in-flight requests**;
  - ratchet `app.server.keepAliveTimeout` down to a shed value (e.g. `1500`) so
    survivors age out fast;
  - when `count` drops below `lowWater`, restore `httpKeepAliveTimeoutMs`.
- `onClose`: `clearInterval`. All timers owned and cleared by the plugin (same
  ownership rule as the dispatcher's `startWebhookDispatcher`).
- Default `httpShedHighWaterConnections = 0` ⇒ sampler is a no-op: zero behavior
  change unless an operator turns it on.

**Why dynamic over static.** A fixed short `keepAliveTimeout` (`Fastify({keepAliveTimeout: 1000})`)
sheds always — including at 3 a.m. when nginx's pooled upstream sockets are doing
no harm and every reconnect costs a fresh TCP+TLS handshake through the proxy. The
dynamic version sheds only when measured pressure says so, which is what the word
"dynamically" in the request asks for.

**3. Tests (new `apps/api/src/plugins/connectionShedding.test.ts`)** — mirror the
repo's real-socket patterns:

- **Shed behavior**: build a Fastify instance with the plugin, `highWater = 1`,
  `checkIntervalMs = 50`; open 3 keep-alive `net` sockets, complete one request on
  each (exactly probe P3's shape); assert `server.getConnections()` falls to
  ≤ lowWater within the sampler period. One case, per stated behavior.
- **Disabled default**: with `highWater = 0` (default), connections stay above
  water and nothing is closed — the plugin is a provable no-op.
- **Regression coupling**: existing `app.inject(...)` tests must stay green —
  the plugin must not alter injected/`inject`-only instances (register it
  conditionally or make it inert when `highWater === 0 && rssBytes === 0`).

**4. Verification (implementation lane, captured evidence):**

| Check | Exact command / scenario | PASS observable |
|---|---|---|
| Suite | `bun test` in `apps/api` (and full `bun test && (cd apps/settlement && go test ./...)` per AGENTS.md) | All green; diagnostics clean |
| Real socket | Boot api against compose Postgres; open 20 keep-alive sockets (`node -e` with `net`); set `HTTP_SHED_HIGH_WATER_CONNECTIONS=5`; watch `ss -tn state established '( sport = :3000 )'` | Count falls from 20 to ~0 within 2 sampler periods while a concurrent `curl` request still succeeds |
| In-flight safety | Start a slow request (e.g. acquirer latency path); trigger shed | Slow request completes 200 — sockets in flight untouched |
| Spike | Re-run FP-209's k6 scenarios (`scripts/out/fp209-loadtest-2026-09-18.json` reference) | No regression vs 41 ms/88 ms p50s; RSS peak < 512 MB |
| Disabled | Boot with defaults | `ss` connection count behaves exactly like today (5 s keep-alive) |

### Site B — pools: **no change**. Optional cleanup (separate ticket, not this
optimization): remove vestigial `pgPoolMin` (`config.ts:16`, `:203`) — parsed, never
consumed by `apps/api/src/db/pool.ts`.

### Site C — reporting: **no change** (10 s pg default already sheds; no HTTP
surface to manage).

---

## 5. Guardrails & lane boundaries

- **Never shed these:** the dispatcher's LISTEN client (`dispatcher.ts:300`) and the
  reporting consumer's LISTEN client (`listener.ts`) — incident 2026-05-14 / #398
  classes (see CHANGELOG: dispatcher LISTEN reconnect fix `a808bf7`; reporting
  LISTEN-leak fix in 1.9.1). Do not touch `apps/reporting`, `apps/settlement`,
  `packages/money`.
- **Proxy interplay:** the deployed path is Cloudflare → platform origin nginx →
  container. That lane owns proxy keeping (`docs/plans/server-nginx-tuning-2026-10-30.md`).
  If that lane sets nginx `keepalive` counts, the app-side shedder's high-water
  should be sized *above* the proxy's pooled count, never below.
- **Other lanes' files:** io-uring lane reads `apps/api/src/db/pool.ts` only;
  batch-commit lane owns `apps/settlement/.../batch.go`; JSON-in-Postgres lane owns
  `archiveReplay.ts`/`replayBatch.ts`. This plan's write list (§4) touches none of
  those, and deliberately uses a **new** test file to avoid the currently-open
  shared test files.
- **Runtime drift guard:** probes ran on this session's Bun 1.4.4; the container's
  Bun version may differ. The implementation lane's smoke check (`ss` count drop)
  re-verifies the mechanism on the shipped image — cheap insurance for a Node-API
  behavior (`closeIdleConnections`) that is newer than the app's other calls.

---

## 6. Evidence appendix (this session)

- **P1 — Bun 1.4.4 `node:http` defaults** (eval js cell, `createServer`):
  `closeIdleConnections: "function"`, `closeAllConnections: "function"`,
  `defaultKeepAliveTimeout: 5000`, `defaultHeadersTimeout: 60000`,
  `defaultRequestTimeout: 300000`, `defaultSocketTimeout: 0`;
  `keepAliveTimeout` set to 1500 stuck; `closeIdleConnections()` call OK.
- **P2 — Fastify 5.12.3 forwards server options** (`Fastify({ keepAliveTimeout: 2345 })`
  + `listen`): `app.server.keepAliveTimeout === 2345`; `typeof
  app.server.closeIdleConnections === "function"`; listened on 127.0.0.1:39791.
- **P3 — shedding works end-to-end under Bun** (same session): 3 keep-alive
  sockets, one `GET /ping` each → `getConnections() = 3`; after one
  `server.closeIdleConnections()` → `getConnections() = 0`.
- **Grep (2026-10-30):** zero occurrences of `keepAliveTimeout`,
  `closeIdleConnections`, `maxConnections` in `ops/`, `apps/`, `packages/`.
- **pg defaults:** `node_modules/pg-pool/index.js:98-99` — unset
  `idleTimeoutMillis` defaults to 10000 ms.
- **Baseline:** `docs/perf/fp-209-loadtest-2026-09.md` — idle RSS 171 MB, peak
  236 MB, cap 512 MB; p50 list 41 ms / summary 88 ms; 0 errors.

---

## 7. Open questions for the orchestrator

1. **Default state:** ship `HTTP_SHED_HIGH_WATER_CONNECTIONS` default `0`
   (disabled) and let ops flip it with evidence, or default-on in demo
   environments? Recommendation: disabled by default; enable with a documented
   high-water during the demo if connection counts justify it.
2. **Sizing the high-water:** needs a real `ss -tn` sample of the demo-day
   connection count before picking the threshold — the plan keeps it env-driven so
   no code change is needed to tune it.
