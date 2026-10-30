# Plan: server-parameter + nginx tuning for the hosted box (dilmune)

> Placement note: this plan lives at `docs/plans/` per the planning-lane contract
> (same as the sibling `io-uring-optimization-2026-10-30.md`). It is the
> **how-we-will-do-it** document for "tune the server and put nginx in front of
> the FilsPay stack". It specifies every parameter and config block so an
> implementing lane can land the change and prove it. It changes **no code**.

| | |
|---|---|
| **Author** | AI planning lane (server + nginx) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — nothing here is implemented. No file outside `docs/plans/` is touched by this lane. This session added a correction + an nginx-circumvention verdict (below). |
| **Target host** | `dilmune` (the hosted demo box). Reachable + verified this session (`ssh dilmune` works; Ubuntu 24.04.5, hostname `dcs-4d199e9b`). See **Addendum — live box reality (2026-10-30)** below: it is a **bare droplet**, not the compose-host assumed by the rest of this document, and the public entry runs behind Cloudflare + a platform-managed nginx. Read the Addendum before acting on §1–§7. |

---

## Addendum — live box reality (2026-10-30): corrections + nginx circumvention verdict

> This session finally got SSH access to `dilmune` and probed where the app actually
> runs. Three facts materially change how to read this document. (User approved this
> doc be updated despite a standing needs-human read-only agreement; scope is this one
> file.)

### 1. `dilmune` is a bare droplet — the compose stack is NOT hosted here

Live discovery (read-only commands via SSH):

| Fact | Value verified |
|---|---|
| OS | Ubuntu 24.04.5 LTS, kernel 6.8.0-142-generic |
| CPU | **1 vCPU** (`DO-Regular`) — not the 0.5 the repo docs claimed |
| RAM | 2047 MB + **2 GB swap** online |
| Disk | 48 GB / 4.1 GB used (44 G free) |
| Listening | **only SSH :22** |
| Stacks | **no nginx, no docker, no Postgres, no compose** installed |
| User | `dilmune` (uid 1000, in `sudo`, NOPASSWD) |

So every assumption in this plan's §1 inventory that the compose stack was already
running here is **wrong**. The box is provisioned with only a platform agent
(`/opt/dilmune/cron-runner.sh` + `report-metrics.sh` POST to `api.dilmune.com`;
`~/sites` and `~/logs` exist and are empty). Deploying the stack here means
**installing** docker + compose + Postgres + bun, not tuning an existing deployment.

### 2. Where the app actually runs: the platform's managed ingress

The public entry `https://api.dilmune.com` answers as **`server: cloudflare`**
(IP 104.21.55.48). The real hop stack is

```
browser → Cloudflare edge → origin nginx → docker containers
```

The origin nginx is the **platform's managed reverse proxy** — it exists because the
user set up a bare Linux server, not a managed Node.js/container app. This is why
bun/nginx/docker are missing from the box: that managed-app layer was never
provisioned for it. The platform's nginx cannot be removed by the app owner, for a
technical reason (the containers sit behind it) — not as a prohibition.

### 3. Verdict: do NOT try to circumvent the platform nginx, and don't build your own on the box

- **Can't, from the container side.** There is no public direct socket to the
  container to go around nginx; bypassing means exposing Fastify naked, which the
  platform won't route. If the demo is served through `api.dilmune.com`, the edge
  nginx is a fixed hop.
- **Wouldn't help even if possible.** A same-origin nginx→Fastify hop is a localhost
  TCP pass-through — microseconds. nginx there is doing TLS termination + host
  routing + header handling + buffering, which removing would push back into
  Fastify. FP-209 already proved the bare app holds the load with no proxy
  involved (list p50 41 ms, RSS peak 236 MB, no OOM).
- **Recommendation:** treat the platform's nginx as infrastructure, not a tunable to
  drop. For maximum performance in the demo window, put effort into **Postgres
  `shared_buffers=128MB`** (proven 3.4 s→410 ms in `docs/perf/`) and a clean
  deploy, and **don't install your own nginx on the bare box** unless the demo runs
  entirely on the box (then a Caddy/Fastify-static front for the panels is the
  simpler choice).

This sharpens (does not reverse) the earlier "skip nginx" advice: skip applies to a
*local dev* topology with no reverse proxy; behind Cloudflare the edge nginx is a
fact of the platform.

**What this means for §1–§7 below:** the tuning values are still valid *as a
checklist* for when a stack is deployed on (or in front of) this box, but §5 step 0
(discover the box) is no longer optional — it already happened, and this Addendum
is its result. Runtime (`bun` vs `tsx`) and Postgres ownership (here vs. the
other DB machine) remain open decisions for the orchestrator.

---

## TL;DR — the honest answer

FilsPay currently ships **with no reverse proxy at all**: the API binds
`0.0.0.0:3000` directly and the two dashboards (`apps/web`, `apps/admin`) are
Vite *dev* servers that call the API cross-origin. Nothing sits in front
terminating connections, compressing responses, or buffering slow clients.

On a box this small (0.5 vCPU / 2 GB RAM / 2 GB disk, API capped at 512 MB) the
wins, in ROI order, are:

| # | Lever | What changes | Why / what it buys |
|---|---|---|---|
| 1 | **Put nginx in front of the API** (reverse proxy) | nginx owns the public listener; it forwards `/v1/*`, `/healthz`, `/readyz` to `127.0.0.1:3000` with `proxy_*` tuning, gzip on JSON responses, buffering, and a client body limit that matches KYC | Offloads keep-alive + gzip + buffering from the 512 MB API; gives one consistent place for headers, timeouts, limits; lets the API keep its small pg pool. The API stays single-replica by design (dispatcher `SKIP LOCKED` makes replicas safe, but the box can't afford more). |
| 2 | **Serve the built dashboards from nginx as static files** (optional, secondary) | nginx serves `apps/web/dist` and `apps/admin/dist` so dashboards and API are **same-origin** | Removes the entire CORS + `cookieSecure` dance for the demo (see `docs/incidents/dashboard-cors-2026-10-30.md`); lowest-latency static serving; tiny dists (272 K / 260 K). Only adopt if the demo wants same-origin dashboards; otherwise keep Vite dev + the existing CORS plugin. |
| 3 | **Tune Postgres for 2 GB** | `shared_buffers` 128 MB already proven; align `work_mem`, `effective_cache_size`, `max_connections` to the small RAM + the app pools | PG is the latency floor; the 128 MB value already cut settlement-summary 3.4 s → 410 ms warm. Everything else must fit 2 GB of RAM shared with the other services. |
| 4 | **Set the Fastify server options the app currently omits** | `trustProxy`, explicit `keepAliveTimeout`, `connectionTimeout`, `bodyLimit` in `apps/api/src/index.ts` | Once a reverse proxy exists, the API needs `trustProxy: true` for correct client IPs, and explicit timeouts so the proxy and app agree. |
| 5 | **Kernel defaults: mostly "do not touch"** | a short sysctl shortlist, nothing exotic | 0.5 vCPU / 2 GB cannot saturate kernel limits; the honest move is a tiny, reason-backed list, not a tuning kitchen sink. |

**What this plan deliberately does NOT do:** it does not switch runtimes (`bun`
vs `tsx`/Node — the io_uring lane owns that), it does not touch settlement
batching or JSON-in-Postgres, and it does not rewrite CORS (which is already
landed).

> Live-note to the orchestrator: `dilmune`'s actual OS, nginx version, and
> whether it even has nginx installed were **unknown** at plan time (host not
> reachable). §7 step 0 is a discovery read — confirm those before applying
> anything.

---

## 1. Grounded inventory (verified against the repo, 2026-10-30)

| Surface | Fact | Where |
|---|---|---|
| Hosted box | 0.5 vCPU / 2 GB RAM / 2 GB disk; API container capped 512 MB; Postgres "defaults are fine at this size" | `ops/README.md` → "Resource sizing" |
| Stack | `docker compose -f ops/docker-compose.yml`: `postgres:16-alpine`, `api`, `settlement` (Go, :8091 internal), `reporting` (worker). api + reporting commands run `bun` | `ops/docker-compose.yml` |
| Panels | `apps/web` (:5173), `apps/admin` (:5174) — **Vite dev servers, not in compose**, cross-origin `http://localhost:3000` | `ops/README.md` → "Quick start"; `apps/web/src/api/client.ts:3`; `apps/admin/src/api/client.ts:4` |
| API listener | `app.listen({ port: config.port, host: "0.0.0.0" })` — bound to all interfaces, no reverse proxy anywhere | `apps/api/src/index.ts` |
| API framework | Fastify 5, built via `buildApp` with **only** `Fastify({ logger: true })` — no trustProxy/bodyLimit/keepAlive override | `apps/api/src/app.ts` |
| HTTP route split | `/healthz`, `/readyz` unprefixed; `/v1/*` for everything else | `apps/api/src/app.ts` route registration |
| pg pool | `pgPoolMax` default **5**, min 0, idle 30 s, connect timeout 5 s | `apps/api/src/config.ts`; `apps/api/src/db/pool.ts:16-20` |
| KYC upload | cap `kycMaxFileSizeBytes = 8_388_608` (8 MB), via `@fastify/multipart` | `apps/api/src/config.ts`; `apps/api/package.json` |
| Perf baseline | 0.5 vCPU/512 MB, `npx tsx` under Node: CSV export p50 **2.21 s** / p95 4.18 s / max 5.93 s (18,432 rows); list p50 41 ms; summary p50 88 ms; RSS idle 171 MB peak 236 MB; no OOM | `docs/perf/fp-209-loadtest-2026-09.md` |
| PG tuning precedent | `shared_buffers` 32 → 128 MB cut settlement-summary 3.4 s → 410 ms warm | `docs/perf/2026-07-settlement-summary-slow.md` |
| CORS | landed; `CORS_ALLOW_ORIGINS` defaults `localhost:5173/5174`, `*` reflects any origin with credentials; `cookieSecure` defaults true under production | `apps/api/src/plugins/cors.ts`; `docs/incidents/dashboard-cors-2026-10-30.md`; `ops/.env.docker` |
| Runtime | compose invokes `bun`; load test + ops notes show `npx tsx`/Node. **Ambiguous** — owned by the io_uring lane, not this one | `ops/docker-compose.yml`; `docs/plans/io-uring-optimization-2026-10-30.md` §3 Site 3 |

**Current state, in one sentence:** the API exposes `0.0.0.0:3000` to the
network with no proxy, no gzip front, and no static-file host; the dashboards
normally run as Vite dev servers on their own ports.

---

## 2. Topology recommendation

### Primary (do this even for the demo): nginx as reverse proxy in front of the API

```
client ──> nginx :80  ──proxy──> api 127.0.0.1:3000   (/healthz /readyz /v1/*)
                    └──static──> /srv/filspay/web, /srv/filspay/admin  (optional, §2.1)
```

- nginx listens on the LAN/public address; the API keeps binding `0.0.0.0:3000`
  (it already does) but is now reachable in practice only through nginx. To make
  the API private, bind it to `127.0.0.1` and let nginx be the only public
  listener — but note the **two-machine demo** (panels on one machine, DB on
  another) calls the API over the LAN, so if the panels machine reaches the API
  directly it still needs the LAN bind + CORS. Decide which demo shape applies
  before tightening the bind (§6 open questions).
- Health passes through: nginx `location /healthz` and `/readyz` → `proxy_pass`
  so orchestrators/PAT-style checks work unchanged.
- gzip on for JSON (the API returns JSON everywhere except the CSV export,
  which is text/csv — keep gzip off for the export or accept the CPU cost;
  export is the largest response, recommend gzip off there, §3.2).

### 2.1 (Optional, secondary) same-origin static dashboards

If the demo should not rely on Vite dev + CORS: build `apps/web` and
`apps/admin` to `dist/` (both already have dists) and serve them from nginx at
`/` (web) and `/admin` (admin), with the API same-origin under `/v1`. This
kills CORS and the `cookieSecure=false` requirement entirely. **Cost:** the
panel builds must set `VITE_API_BASE_URL` to a same-origin path (e.g. build with
`VITE_API_BASE_URL=`` → it already defaults the API base to `http://localhost:3000`,
so it must be rebuilt for the public origin), and the admin's `VITE_WEB_BASE_URL`
must match. This is a build-config change owned by an implementing lane, gated
by whether the demo uses dev or built panels.

---

## 3. The parameter plan

### 3.1 nginx — file locations and top-level

Where the file lives on `dilmune` depends on the distro already there:

- Debian/Ubuntu: `/etc/nginx/sites-available/filspay.conf` + `ln -s` into
  `/etc/nginx/sites-enabled/`
- RHEL/Fedora/CentOS: `/etc/nginx/conf.d/filspay.conf`

The implementing lane confirms the distro and nginx version in §7 step 0, then
drops the block below into whichever path is live. `nginx -t` must pass before
`systemctl reload nginx`.

**Top-level tunables** (in `nginx.conf` `events`/`http` blocks — the defaults
in the distribution package are fine except `worker_processes`):

| Param | Recommended value | Reason |
|---|---|---|
| `worker_processes` | `1` (or `auto`, which yields 1 on a 0.5 vCPU box) | nginx is I/O-bound proxying; 1 worker is all a single vCPU can drive; more just contend. |
| `worker_connections` | `1024` | The box never sees high concurrency; the FP-209 test ran 28 concurrent VUs max. 1024 is ample and cheap. |
| `keepalive_timeout` (client) | `65` | A touch above the API's 60 s proxy timeout so a slow client doesn't get cut before the upstream answers. |
| `sendfile` / `tcp_nopush` | `on` | Defaults; correct for proxying + static. |
| `client_max_body_size` | `16m` | The KYC cap is 8 MB plus multipart framing; 16 m gives headroom without enabling abuse. |
| `gzip` | `on`; level `5`; `min_length 1024`; types json/js/css/svg | JSON API responses compress well; level 5 balances CPU (0.5 vCPU!) vs ratio. |

### 3.1.1 nginx `server` block — copy-paste for the API reverse proxy

```nginx
# /etc/nginx/conf.d/filspay.conf  (or sites-available + symlink, per distro)
# PLAN ONLY — reference implementation for the implementing lane.
# Listens on all interfaces. Put a real listen address (e.g. the public/LAN
# IP) here if the API should be LAN-only.

server {
    listen 80 default_server;
    server_name _;

    # client body limit matches KYC upload (app cap 8MB + multipart overhead)
    client_max_body_size 16m;

    # ---- health through-pass (process + DB reachability) ----
    location = /healthz { proxy_pass http://127.0.0.1:3000/healthz; }
    location = /readyz  { proxy_pass http://127.0.0.1:3000/readyz;  }

    # ---- the API surface ----
    location /v1/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection        "";   # upstream keep-alive

        # upstream timeouts: must exceed the slowest legit route (CSV export
        # p95 4.2s, max ~6s; give headroom) and the settlement internal call.
        proxy_connect_timeout 10s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;

        # buffer the (largest) upstream response so a slow client doesn't
        # stall the API worker.
        proxy_buffering on;
        proxy_buffers 8 16k;
        proxy_buffer_size 8k;
    }

    # ---- gzip only JSON-ish, upstream already helps keep CPU low ----
    gzip on;
    gzip_min_length 1024;
    gzip_types application/json text/javascript application/javascript
               application/xml text/css image/svg+xml;
    gzip_vary on;

    access_log /var/log/nginx/filspay.access.log;
    error_log  /var/log/nginx/filspay.error.log warn;
}
```

Notes for the implementer:
- `Connection ""` + `proxy_http_version 1.1` is what makes nginx keep its
  upstream sockets alive to the API (and later, to whatever TCP Fastify/Node
  runtime is in use). Without it, nginx opens a fresh connection per request.
- The export route returns `text/csv`; it is deliberately **not** in
  `gzip_types`, so the biggest response is not double-compressed by nginx
  (avoiding CPU that the 512 MB API box doesn't have to spare while the API's
  own export already builds the string in memory).
- If the API's `NODE_ENV=production` session cookie is `Secure`, the proxy path
  must be HTTPS or `COOKIE_SECURE=false` must be set (see §3.4 / the CORS
  incident). nginx does **not** terminate TLS in this plan — TLS is out of
  scope for the LAN/hackathon demo.

### 3.2 nginx static dashboards (secondary, only if same-origin demo)

```nginx
    # inside the same server block, if serving built panels (OPTIONAL §2.1)
    location / {
        root /srv/filspay/web;
        try_files $uri /index.html;          # SPA history fallback
        expires 1h;
    }
    location /admin {
        alias /srv/filspay/admin;            # or a base-path build, pick one
        try_files $uri $uri/ /admin/index.html;
        expires 1h;
    }
```

`/srv/filspay/web` and `/srv/filspay/admin` are the `dist/` outputs of
`apps/web` and `apps/admin` copied onto `dilmune`. This branch is **entirely
optional** and only worth it if the demo wants built, same-origin dashboards.

### 3.3 Kernel/sysctl — the tiny, reason-backed list

On a 0.5 vCPU / 2 GB box that proxied this load, most kernel defaults are
already fine and touching them is risk without return. The short list that *can*
matter under a proxy + pg, in `/etc/sysctl.d/99-filspay.conf`:

| Param | Recommended | Reason / not-recommending the rest |
|---|---|---|
| `fs.file-max` | leave default (or `1048576`) | Node/pg connection counts are tiny; the default is enough. Only raise if `EMFILE` appears. |
| `net.core.somaxconn` | `1024` (several distros default 128) | Fastify/Node listen backlog. With nginx in front only nginx's backlog matters much; 1024 is safe. |
| `net.ipv4.tcp_tw_reuse` | `1` | Reuse TIME_WAIT sockets quickly — mildly useful for many short-lived client↔nginx transitions. **Do not** touch `tcp_tw_recycle` (removed/harmful). |
| `vm.swappiness` | `10` (if swap exists) | Keep pages resident; harmless. Irrelevant if no swap on a 2 GB box (before that, the pg tuning is the real fix). |
| `vm.overcommit_memory` | leave default | Default heuristic is correct for a 2 GB box; forcing `2` risks OOM under the API's memory spikes (sharp). |

Everything else commonly seen in "server tuning blogs" (huge `rmem/wmem`, giant
`tcp_mem`, `netdev_max_backlog`) is **not warranted**: 0.5 vCPU can't generate
or absorb enough traffic for those to be the bottleneck, and they only steal RAM
from Postgres's buffer cache and the API. The implementer should also run the
checks in §7 (in particular the OOM / `dmesg` check) rather than tuning preemptively.

### 3.4 Postgres — 2 GB budget

Applies to the DB running on `dilmune` (or, in the two-machine demo, the DB
machine). Postgres is the latency floor; this is where tuning pays.

| Param | Recommended for 2 GB | Reason |
|---|---|---|
| `shared_buffers` | `128MB` | **Proven:** 32 → 128 MB cut settlement-summary 3.4 s → 410 ms warm (`docs/perf/2026-07-settlement-summary-slow.md`). This is the single highest-value setting. |
| `effective_cache_size` | `~1024MB` (~50 % of 2 GB) | Tells the planner how much OS page cache to assume; keeps index cost estimates sane. |
| `work_mem` | `4MB` (leave default or `8MB` max) | Total RAM is small and every sort/hash could multiply this by per-connection; on 2 GB, 4–8 MB is the right ceiling so exports/sorts don't blow past available RAM. |
| `maintenance_work_mem` | `64MB` | For VACUUM/ANALYZE; still small enough to leave headroom. |
| `max_connections` | `50` (default 100 is also fine) | Must cover api pool (5) + reporting pool + settlement pool + healthchecks; there is no reason to allow 100 on 2 GB. Confirm actual pool caps first — raising it just wastes memory (each backend is ~5-10 MB). |
| `checkpoint_completion_target` / `wal_buffers` | leave defaults | OLTP-light; defaults are fine. |
| `fsync` / `synchronous_commit` | leave default `on` | Do **not** disable durability for a payments system. |

Where these live for the compose stack: pass them via `command`/
`POSTGRES_*` in `ops/docker-compose.yml`, or via a mounted `postgresql.conf`
on `/etc/postgresql/*/postgresql.conf` for a direct install. The implementing
lane plus the orchestrator decide whether to change the compose Postgres or a
host database (see §6 open Q1 — two-machine demo means the DB may not even be on
`dilmune`).

### 3.5 Fastify server options the app currently omits

One small edit in `apps/api/src/index.ts` (owned by the implementer, **not**
this doc): `buildApp` returns a Fastify instance; the listening options live at
`app.listen(...)`. Because nginx now fronts the API:

| Opt | Recommended | Why |
|---|---|---|
| `trustProxy` | `true` (in the `Fastify({...})` opts in `app.ts`) | With nginx forwarding, Fastify must trust `X-Forwarded-For`/`X-Forwarded-Proto` or every request appears to come from 127.0.0.1 and any host/SSL-dependent logic (cookies, request IP) breaks. Only safe now that nginx is the sole public front. |
| `connectionTimeout` | `0` (default) or explicit `60000` | nginx `proxy_read_timeout 60s` bounds it; keep the app idle-tolerant. |
| `keepAliveTimeout` | explicit `60000` (Node default 5 s can hurt keep-alive reuse under a proxy) | Aligns with nginx's 60 s read timeout so keep-alive from nginx isn't killed early. |
| `bodyLimit` | leave default 1 MB **for non-multipart**; multipart routes use their own limit | The KYC 8 MB cap is enforced by the multipart plugin, not `bodyLimit`; nginx `client_max_body_size 16m` already guards the wire. Do not raise global `bodyLimit` for the 8 MB path. |

These Fastify opts are the **only** production-code edit in this plan, and only
`trustProxy` + `keepAliveTimeout` are strictly needed; everything else the
compose/env layer handles.

---

## 4. What this lane will NOT do (scope boundary — read this, implementer)

- **No code in this planning lane.** Nothing outside `docs/plans/` is edited by
  this document's author. The Fastify/nginx/Postgres changes above are the
  implementing lane's work.
- **No runtime switch** (`bun` vs `tsx`/Node) — owned by the io_uring lane
  (`docs/plans/io-uring-optimization-2026-10-30.md` §3 Site 3). The nginx
  `proxy_pass` targets `127.0.0.1:3000` regardless of runtime, so unaffected.
- **No settlement/JSON/lane crossover** — no edits to
  `apps/settlement/internal/settlement/batch.go`, `docs/design/json-in-postgres-vs-app.md`,
  webhook archive/replay.
- **AGENTS.md hard rules honored** — no `packages/money/` edits, no test-file
  edits, no monetary-column widening, no change to `v1/` stubs or
  `WEBHOOK_ELIGIBLE_EVENT_TYPES`.
- **No TLS termination in this plan** — leftover open decision (§6), out of
  scope for a LAN/hackathon demo.

---

## 5. Migration / verification steps (for the implementing lane)

Order matters. Step 0 is where the plan's ground-truth gap closes.

0. **Discover the box** (required — `dilmune` was unreachable at plan time):
   `ssh dilmune` → `uname -r`, `cat /etc/os-release`, `nginx -v` (or is nginx
   installed?), `free -m`, `df -h`, `docker compose ls` / the actual running
   services, and `dmesg -T | grep -i 'oom\|killed process'`. Record these;
   every value in §3 is a starting point to be confirmed against this.
1. **Back up current nginx config** (`cp -a /etc/nginx /etc/nginx.bak` or `git`
   the conf dir) and `nginx -t` before/after placing §3.1.1.
2. **Apply the reverse proxy** (§3.1), `systemctl reload nginx`, then prove:
   - `curl -i http://127.0.0.1/healthz` → `200` (through nginx)
   - `curl -i http://127.0.0.1/readyz` → `200`
   - `curl -i http://127.0.0.1/v1/...` → matches the API's response (pick one
     public route)
   - `curl -i -H 'Accept-Encoding: gzip' http://127.0.0.1/v1/...` → response has
     `Content-Encoding: gzip` (JSON route)
   - `nginx -t` → `syntax is ok` + `test is successful`
3. **Apply kernel sysctl** (§3.3): `sysctl --system` (or
   `sysctl -p /etc/sysctl.d/99-filspay.conf`), then `sysctl net.core.somaxconn`
   shows `1024`.
4. **Apply Postgres tuning** (§3.4) and reboot/reload PG; then re-run the two
   `docs/perf/` scenarios (settlement summary + CSV export) and **record the
   numbers** in `docs/perf/` — PASS is "no regression vs the FP-209 baselines"
   (list p50 41 ms, summary p50 88 ms, export p50 2.21 s) and a confirming
   `SHOW shared_buffers;` → `128MB`.
5. **Apply Fastify opts** (§3.5), `docker compose up -d --force-recreate api`,
   and confirm the API still serves `/healthz` `200` and a login POST works
   (the trustProxy change is behavior-relevant: assert a request logged with the
   real client IP, not `127.0.0.1`).
6. **Watch for regressions after restart:** `dmesg -T | grep -i oom`,
   `docker inspect <api> --format '{{.State.OOMKilled}}'` → `false`, and the
   `docs/incidents/dispatcher-listen-drop-2026-10-30.md` LISTEN drop should stay
   absent (nobody touched the dispatcher, but a proxy change can shift log
   causality — verify cleanly).
7. **Two-machine demo smoke (if applicable):** from the panels machine,
   `curl` the API through nginx's address; confirm CORS succeeds if the panels
   still run as Vite dev (the `CORS_ALLOW_ORIGINS` / `COOKIE_SECURE=false` path
   from the CORS incident), or that same-origin dashboards (§2.1) work if built.

---

## 6. Open questions (for the orchestrator — not blockers for this document)

1. **Is Postgres on `dilmune` or on the DB machine?** The two-machine demo puts
   Postgres on one box and the panels/API/settlement/reporting on another
   (`docs/incidents/...` + `notes/facts/2026-10-30-runbook-state.md`). The
   Postgres tuning (§3.4) applies wherever PG runs — confirm placement before
   landing.
2. **Which demo shape?** Same-origin built dashboards behind nginx (§2.1 —
   removes CORS, needs panel rebuilds) vs. the current Vite-dev + CORS path
   (no rebuilds, keeps `COOKIE_SECURE=false` / CORS config). This decides
   whether §2.1 ships.
3. **TLS?** Out of scope here, but if the demo needs HTTPS (a public URL,
   secure cookies without `COOKIE_SECURE=false`), nginx must terminate TLS. Not
   planned; flag for a follow-up lane.
4. **Bind tightening:** should the API be bound to `127.0.0.1` behind nginx for
   the single-box shape, or keep `0.0.0.0` for the two-machine demo? Depends on
   Q1/Q2.
5. **nginx present on `dilmune`?** Unknown at plan time; step 0 of §5 answers
   it (install or use the distro's existing package).

---

## 7. Risks and fail-safes

- **Ground-truth gap (biggest):** the box was unreachable during planning, so
  nginx version/install, OS, and live RAM/disk state are assumptions. Failure is
  cheap to catch: §5 step 0 + `nginx -t` gate every change; nothing auto-applies.
- **trustProxy regression:** if nginx isn't actually in front (or a route is
  reachable directly), `trustProxy: true` lets a spoofed `X-Forwarded-For`
  through. Mitigate by making nginx the only public listener (Q4) and, at
  minimum, never trusting the proxy if the API stays LAN-exposed.
- **PG work_mem too high on 2 GB:** a big sort × many connections could
  pressure RAM. The §3.4 values (4–8 MB) are deliberately conservative; re-verify
  with `free -m` after heavy use, not preemptively.
- **gzip on the 0.5 vCPU box:** gzip is CPU work; off for `text/csv` (the export)
  and `min_length 1024` keeps it off tiny bodies. If CPU pegs, drop `gzip_level`
  to 2.
- **No-regression rule:** every change is behind a `nginx -t` / `SHOW` /
  `docker inspect` / perf re-run. A change that regresses FP-209 numbers or
  trips OOM is reverted, not tuned around.
- **Evidence-gated by design:** if after §3 the small box shows no measurable
  gain on the `docs/perf/` scenarios, stop and keep only what paid off — a
  documented "no" is a correct outcome here.

## 8. Verified facts (checked 2026-10-30 in-session)

- API binds `0.0.0.0:3000` directly with no proxy: `apps/api/src/index.ts`
  (`app.listen({ port: config.port, host: "0.0.0.0" })`).
- Fastify built with only `logger: true` (`apps/api/src/app.ts`); route split
  `/healthz`, `/readyz`, `/v1/*` enumerated in the same file.
- pg pool max 5 default + rationale (`apps/api/src/config.ts`,
  `apps/api/src/db/pool.ts:16-20`).
- KYC cap 8 MB (`apps/api/src/config.ts` `kycMaxFileSizeBytes`).
- Panels are Vite dev with cross-origin API base
  (`apps/web/src/api/client.ts:3`, `apps/admin/src/api/client.ts:4`).
- Host shape 0.5 vCPU / 2 GB / 2 GB, API 512 MB, Postgres defaults "fine"
  (`ops/README.md` → Resource sizing).
- FP-209 load baselines and the shared_buffers 128 MB precedent
  (`docs/perf/fp-209-loadtest-2026-09.md`,
  `docs/perf/2026-07-settlement-summary-slow.md`).
- No nginx/Dockerfile artifacts are present in the repo tree today
  (git grep for nginx/proxy_pass/conf → empty; `ops/` has only
  `docker-compose.yml`, `README.md`, `.env.docker`).