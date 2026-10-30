# Plan: how to serve the site (manual serve on the box — cloud-dashboard proxy is unavailable)

> Placement note: lives at `docs/plans/` per the planning-lane contract. This is the
> **how-we-will-do-it** document for **how the site is served to visitors**, updated
> after the user reported (2026-10-30) that the cloud dashboard's reverse-proxy setup
> **cannot be configured** (a platform problem the mentors confirmed). So the serve
> front must be **done manually on the box**, and nginx is **not required** (no plan
> mandates own-nginx; the sibling `server-nginx-tuning` plan explicitly recommends
> against it). It changes **no code** — decision + implementer instructions.
> The on-box nginx/proxy tuning (param values, gzip, buffering) stays owned by the
> separate lane `server-nginx-tuning-2026-10-30.md`; this doc owns the *ingress choice*
> and the port.

| | |
|---|---|
| **Author** | AI planning lane (site serving) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — nothing implemented; no file outside `docs/plans/` is touched. |
| **Decision** | **Serve manually on the box: the Fastify API on port 3000 serves the built dashboards same-origin alongside `/v1/*`** (add `@fastify/static` as an implementing-lane change). **Skip nginx** — no plan requires it, and the sibling plan recommends against installing own nginx on the box. Optionally a **Caddy** front only if a standalone reverse proxy is genuinely wanted (it is not needed for same-origin). |

---

## Addendum — cloud-dashboard proxy unavailable; manual serve + skip nginx (2026-10-30)

> User reported: the mentors say the cloud dashboard has a problem that prevents
> configuring the reverse proxy there. Therefore the site must be served **manually on
> the server**. The user also concluded this means **nginx can be skipped** unless a
> certain plan prevents it.

Sibling-plan check (read this session, `server-nginx-tuning-2026-10-30.md` Addendum §3):

> "**don't install your own nginx on the bare box** unless the demo runs entirely on the
> box (then a Caddy/Fastify-static front for the panels is the simpler choice)."

So **no plan requires own-nginx** — the sibling plan actively recommends *against* it.
The skip is safe. What remains is: what serves the site on the box, and on what port.

**Answer:** the **API itself** — Fastify on **port 3000** — serves both the built
`apps/web`/`apps/admin` dists and the `/v1/*` API same-origin. Add `@fastify/static`
(the implementing lane registers a `fastify-plugin` that serves `apps/web/dist` at `/`
and `apps/admin/dist` at `/admin`; the API already keeps its `/v1/*` routes). One
process, one port, same-origin, no CORS, no `COOKIE_SECURE=false`. This is the
"Fastify-static front" the sibling plan names as the simpler choice, and it needs no
reverse proxy at all — you do not have to stand up nginx **or** Caddy unless a real
forwarding proxy is wanted.

**Only if a standalone reverse proxy is genuinely wanted** (e.g. the box must be reached
directly with its own TLS, or the dashboards are served by a different process than the
API): use **Caddy** — a single static binary, auto-HTTPS, and a one-line
`handle /  root */srv/*/dist` + `reverse_proxy /v1/* 127.0.0.1:3000` — not nginx. nginx
remains handled by the sibling tuning lane if that path is ever taken, but it is not
required here.

---

## 1. The question, restated (superseded portion)

*The original cloud-dashboard framing is kept for provenance; the live answer is the
Addendum above — **serve manually on the box, port 3000, skip nginx / no reverse
proxy needed**.*

The cloud dashboard offered two ways to expose the site:

1. **Serve a static directory over HTTPS** — upload/point at a folder of static files
   (the built dashboards), platform TLS-terminates and serves it as a site.
2. **Reverse proxy** — forward a public host (or a host/path) to a running service on
   a port on the box.

> Which one, and which port?

## 2. What "the site" actually is (grounded in the repo)

FilsPay is **not a static site**. It is a live API plus two browser SPAs that call it:

| Piece | What it is | Address when running |
|---|---|---|
| **apps/api** | Fastify 5 service — holds all auth, data, KYC, webhooks | binds `0.0.0.0:3000` (config default `PORT=3000`; compose publishes `3000:3000`) |
| **apps/web** | merchant dashboard SPA | Vite dev **:5173**, or built to `apps/web/dist` (272 K) |
| **apps/admin** | ops console SPA | Vite dev **:5174**, or built to `apps/admin/dist` (260 K) |
| health | `/healthz`, `/readyz` | on the API, :3000 |
| settlement / reporting | internal workers, **not** user-facing | settlement internal :8091 |

Verified: `apps/api/src/config.ts` (`PORT` default 3000), `apps/api/src/index.ts`
(`app.listen({ port: config.port, host: "0.0.0.0" })`), `ops/docker-compose.yml`
(publishes `3000:3000` only — no port 80/443 published to a service), both
`apps/web|admin/dist` exist, both client.ts default `VITE_*_API_BASE_URL` to
`http://localhost:3000`.

So the "site" a visitor needs is: **the dashboards + the API they talk to**. The API is a
long-running process — *it cannot be emitted as static files.* That single fact decides
the question.

## 3. Decision (live, post-Addendum)

### ✅ Serve manually on the box: the API on port **3000** serves the built dashboards

Now that the cloud-dashboard reverse proxy is unavailable, the honest shortest path is
**no reverse proxy at all** on the box — the Fastify API already binds `0.0.0.0:3000`,
so it can serve the built dashboards **and** the `/v1/*` API from one process, same
origin:

- The public host → Cloudflare/origin nginx → the API container on :3000.
- The API serves `/v1/*`, `/healthz`, `/readyz` as today, **plus** `apps/web/dist` at
  `/` and `apps/admin/dist` at `/admin` via a registered `@fastify/static` plugin.
- Dashboard and API share one origin, which kills the entire CORS + `cookieSecure`
  problem documented in `docs/incidents/dashboard-cors-2026-10-30.md`: `credentials:
  include` cookies just work same-site, no `COOKIE_SECURE=false` needed.

### Port: **3000**

- The API on **port 3000** is the only live, user-facing app port (config default +
  compose publish `3000:3000`). It holds both the API and the dashboards.
- **Not** 80/443 as a *downstream* app port: the platform/origin nginx terminates TLS
  in front; FilsPay never binds them.
- **Not** 5173/5174: those are Vite *dev* ports for local work, not a serve target.
- **Not** 8091: settlement is an internal worker link, never the public surface.

### nginx: skipped, and no plan prevents it

- Verified this session: no plan requires own-nginx. The sibling plan says verbatim
  "**don't install your own nginx on the bare box**" (if the demo runs entirely on the
  box, a Caddy/Fastify-static front is the simpler choice). So **do not install nginx**
  for this. The only nginx in the path is the platform's managed origin nginx, which is
  infrastructure the owner does not control.

### Why not a standalone reverse proxy (nginx or Caddy)

- A reverse proxy that just forwards `/v1/*` to `127.0.0.1:3000` adds a process and a
  port for zero same-origin benefit when the API can serve the dists itself — the
  dashboards and API already share an origin on :3000.
- The only reason to add a standalone proxy is if the dashboards must be served by a
  *different process* than the API (untrue here) or the box must terminate its own TLS
  (the platform already does). If that ever changes, use **Caddy**, not nginx — one
  static binary, auto-HTTPS, no config complexity.

### Why not the "static directory over HTTPS" option

- A static directory can only hold files. It **cannot run the API** — the live service
  that backs login and every dashboard view. Serving only the built dashboards as
  static files gives you a page that loads but a site that does nothing.
- The dashboard bundles default their API base to `http://localhost:3000`
  (`apps/web/src/api/client.ts:3`, `apps/admin/src/api/client.ts:4`) — served by a
  static host on a different origin, those calls point at the *visitor's own machine*
  and fail.

## 4. What the implementer does (owned by an implementing lane, not this doc)

1. **Keep** `PORT=3000` and the `0.0.0.0` bind (already the case in
   `apps/api/src/index.ts`). Do **not** change the API's bind or port.
2. **Add the dashboards to the API** (the one production change): install
   `@fastify/static` and register a plugin that serves the built dists — `apps/web/dist`
   at `/` (SPA history fallback) and `apps/admin/dist` at `/admin`. The existing
   `/v1/*` routes stay as they are; the static plugin must not shadow `/v1`.
3. **Place/copy** `apps/web/dist` and `apps/admin/dist` where the API reads them (deploy
   time) and rebuild the dashboards with `VITE_API_BASE_URL=`` (empty → same-origin) so
   the browser fetch goes to the same host as the page.
4. **Fallback if the API-static change is not wanted:** run the dashboards as Vite dev
   bound to the LAN and keep the existing CORS path (origin allow-list,
   `COOKIE_SECURE=false` on plain HTTP) — acceptable only for a local/demo LAN, not a
   public HTTPS surface.
5. Verify per §5.

## 5. Verification (implementer)

- API serves the site: `curl -i http://<box>:3000/` → `200` (web dist), `/admin` →
  `200` (admin dist), `/healthz` and `/readyz` → `200`, and a login POST to
  `/v1/auth/login` → expected response — all on port 3000.
- Same-origin dashboards: open the public HTTPS URL for `/` (web) and `/admin` (admin),
  log in, and confirm no CORS console errors and the session cookie sticks
  (`curl -i` shows the set-cookie over the HTTPS front).
- Vite-dev fallback (only if used): confirm the dashboard's network tab calls the public
  API URL (not `localhost`), CORS `access-control-allow-origin` is returned, and
  `COOKIE_SECURE=false` is set for the plain-HTTP host.

## 6. Open questions (for the orchestrator)

1. Confirm the platform forwards the public site's HTTPS host to the API container on
   **port 3000** (since the cloud-dashboard reverse-proxy config is broken, the manual
   serve replaces it — the platform terminator just needs to point at :3000).
2. Runtime (`bun` vs `tsx`) is owned by the io_uring lane and does not change the serve
   port — `:3000` is the target regardless.
3. Whether the demo uses built dashboards (needs a `VITE_API_BASE_URL=`` rebuild +
   `@fastify/static`) or dev dashboards (LAN path) — decides step 4's branch.

## 7. Verified facts (checked 2026-10-30 in-session)

- API binds `0.0.0.0:3000`, `PORT` default 3000: `apps/api/src/config.ts`,
  `apps/api/src/index.ts`.
- compose publishes only `3000:3000` (api) and `5432:5432` (postgres); settlement is
  internal :8091, dashboards are not in compose: `ops/docker-compose.yml`.
- Both dashboards have built dists (web 272 K, admin 260 K): `apps/web/dist`,
  `apps/admin/dist`.
- Both SPA clients default their API base to `http://localhost:3000`:
  `apps/web/src/api/client.ts:3`, `apps/admin/src/api/client.ts:4`.
- Cross-origin CORS + `cookieSecure` incident and its fix:
  `docs/incidents/dashboard-cors-2026-10-30.md`.
- Host-side nginx tuning (proxied upstream params, gzip, trustProxy) is owned by
  `docs/plans/server-nginx-tuning-2026-10-30.md`, which recommends **against** own-nginx
  on the box — this doc serves the site directly from the API on :3000 and needs no
  on-box proxy.
- The API does **not** currently depend on `@fastify/static` (verified in
  `apps/api/package.json` deps) — that dependency + plugin registration is the sole
  implementing-lane production change.