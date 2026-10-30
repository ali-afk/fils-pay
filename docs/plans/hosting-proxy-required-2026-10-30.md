# Plan: host FilsPay on the cloud server's IP behind a required reverse proxy

| | |
|---|---|
| **Author** | AI planning lane (hosting / reverse proxy) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY. Nothing implemented. This lane writes one file: this document. |
| **Scope** | How the implementing lane serves FilsPay from the cloud server's bare IP, with a reverse proxy in front. No custom domain. Plain HTTP. |
| **Supersedes** | `docs/plans/site-serving-cloud-dashboard-2026-10-30.md` (its "skip nginx / no reverse proxy needed" decision) and the addendum guidance in `docs/plans/server-nginx-tuning-2026-10-30.md` ("don't install your own nginx on the bare box"). Both stay frozen and unedited. |

## 1. Status — rubric change

The final rubric for this demo is: **host directly on the cloud server's IP, with a reverse proxy in front, and the proxy is required.**

This supersedes the earlier decision recorded in `docs/plans/site-serving-cloud-dashboard-2026-10-30.md`, which concluded "serve manually on the box, port 3000, skip nginx / no reverse proxy needed" (that file, lines 9 to 14 and 97 to 98). It also supersedes the advice in the `server-nginx-tuning-2026-10-30.md` addendum that says "don't install your own nginx on the bare box" (that file, lines 74 and 78).

The originals stay frozen per the user's instruction ("do not edit the originals"). This document supersedes them in place. Where the two conflict, this document wins. Read the older two for provenance, not for the current decision.

The change arrived in two user messages on 2026-10-30, in this order:

1. "rubric change due to cloud provider issue, hosting will be directly on the cloud server's ip, no domain or reverse proxy necessary"
2. "another sudden change of plan, turns out a proxy is necessary"

Message 1 dropped the domain and the old cloud-dashboard path. Message 2 reinstated the proxy, but not the domain. The plan below is built for exactly that shape: bare IP, port 80, proxy in front, no TLS from ACME.

## 2. Rubric source and provenance

The PDF hosting requirements, quoted verbatim:

> Submission table item 4: "Live deployment ... Your running server ... Must stay reachable until judging ends. Put the URLs on the cover page of your submission document."

> "Cover page ... Live URLs for checkout, the merchant dashboard, the admin console and the public API"

> "Architecture and deployment ... A diagram showing every service and port, and which ones face the internet"

> "The one command (or infrastructure as code) to redeploy"

> "Where secrets come from"

> "Health checks, restart policies, and how a redeploy avoids interrupting a settlement run"

> "3. Your server is up, your live links open, and it stays reachable until judging ends."

**The PDF text itself contains no occurrence of "proxy", "domain", "nginx", "Caddy", or "TLS".** I extracted `docs/FilsPay_Submission_Guidelines.pdf` with `pdftotext` and searched case-insensitively: zero matches for all five terms. The reverse-proxy mandate does **not** come from the PDF. It comes from the team and organizer decision relayed in the user's message on 2026-10-30: "turns out a proxy is necessary". Do not attribute the proxy requirement to the PDF text in the submission document, and do not imply the PDF asked for one.

What the PDF does require, and what this plan must therefore satisfy, is narrower and concrete: a live deployment reachable until judging ends, live URLs on the cover page, an architecture diagram showing every service and port and which face the internet, one redeploy command, a statement of where secrets come from, and health checks plus restart policies that let a redeploy avoid interrupting a settlement run.

## 3. Current state of the existing plans (facts from the harvest ledger)

Provenance note: the expected harvest ledger at `/tmp/ulw-waves/hosting-proxy/harvest.md` did not exist when this document was written (the directory `/tmp/ulw-waves/hosting-proxy/` was present but empty). To avoid inventing citations, every reference below was re-read directly from the source files in this session and is cited by `file:line`. Treat these as claims to re-verify, not as proof.

### 3.1 Deployed topology as documented

- The public entry answers as Cloudflare. `https://api.dilmune.com` returns `server: cloudflare` from IP 104.21.55.48: `docs/plans/server-nginx-tuning-2026-10-30.md:47`.
- The hop stack is `browser → Cloudflare edge → origin nginx → docker containers`: same file, line 51.
- The origin nginx is the platform's managed reverse proxy, not something the repo installs: same file, lines 54 to 58.
- The API binds all interfaces on port 3000: `apps/api/src/index.ts:23` (`app.listen({ port: config.port, host: "0.0.0.0" })`). Recorded in `docs/plans/server-nginx-tuning-2026-10-30.md:137` and `docs/plans/site-serving-cloud-dashboard-2026-10-30.md:77`.
- Compose publishes `3000:3000` for the API and `5432:5432` for Postgres: `ops/docker-compose.yml:24` and `ops/docker-compose.yml:76-77`. Settlement listens on internal `:8091` and is not published: `ops/docker-compose.yml:86,98`.
- No compose service declares a restart policy today: `ops/docker-compose.yml` has no `restart:` key. That is a gap the implementer closes (section 4.5).

### 3.2 The site-serving decision and why it is superseded

`docs/plans/site-serving-cloud-dashboard-2026-10-30.md` decided that the Fastify API on port 3000 should serve the built dashboards same-origin via `@fastify/static`, with **no proxy at all** on the box. Its header and decision table say so at lines 1 to 14; the live decision is restated at lines 97 to 98 ("no reverse proxy at all on the box").

That decision is superseded because the proxy is now required by the rubric, not because its technical analysis was wrong. The same-origin argument it makes is still the reason the public listener should serve both dashboards and API from one origin. What changes is who owns that origin: a real proxy process on port 80, not the app process on port 3000.

Two details from that plan survive and the implementer should keep them:

- The dashboards are SPAs and need history fallback.
- `apps/web/src/api/client.ts:3` and `apps/admin/src/api/client.ts:4` default their API base to `http://localhost:3000` (`site-serving-cloud-dashboard-2026-10-30.md:153-155`). A public build must use a same-origin base (empty `VITE_API_BASE_URL`), otherwise the browser calls the visitor's own machine.

### 3.3 The nginx addendum and why the direct-IP plus proxy rubric moves past it

The nginx tuning plan's addendum says "don't install your own nginx on the bare box" (`server-nginx-tuning-2026-10-30.md:74`) and frames that as sharpening, not reversing, the earlier skip advice (line 78). Its reasoning was that the platform's managed nginx already fronted the app, so a second proxy added nothing.

The rubric change removes that premise. Hosting directly on the bare IP means there is no platform ingress in the path, yet the rubric still requires a proxy. So a proxy must be run on the box after all. The tuning plan's *parameter* guidance now applies (upstream keep-alive, buffering, `client_max_body_size`, timeouts), even though its *installation* advice does not. This document reuses that guidance in spirit while choosing Caddy as the process.

Its `trustProxy` rationale is now genuinely applicable: `server-nginx-tuning-2026-10-30.md:342` says Fastify needs `trustProxy: true` and `X-Forwarded-For` / `X-Forwarded-Proto` handling once a reverse proxy exists. It also warns at lines 442 to 444 that `trustProxy: true` is only safe while the proxy is the sole public front, because a directly reachable API would accept spoofed forwarding headers. Section 4.4 keeps that constraint.

### 3.4 The CORS claim that is not true

`docs/plan-review-findings-2026-10-30.md:24` calls "CORS is landed" the single most important false foundation in the plans. The evidence it gives (lines 31 to 41):

- No `apps/api/src/plugins/cors.ts` exists; the plugins directory has only `cookies.ts`, `errorHandler.ts`, and `multipart.ts`.
- No `CORS_ALLOW_ORIGINS` appears in `apps/api/src/config.ts` or `ops/.env.docker`.
- No `@fastify/cors` dependency exists in `apps/api/package.json` or `node_modules/@fastify/`.

I re-checked the tree in this session and got the same result: a grep for `@fastify/cors`, `CORS_ALLOW_ORIGINS`, and `cors` across `apps/api/src` and `apps/api/package.json` returned no code or dependency matches. The only CORS-adjacent reality is the `cookieSecure` / `COOKIE_SECURE` config and the clients' `credentials: "include"`.

Consequences for the implementer:

- Do not build on "CORS already works". It does not exist.
- The primary design below avoids CORS entirely by serving dashboards and API on one origin through the proxy. That is the safest path and needs no CORS plugin.
- The optional LAN two-machine demo in section 4.7 does need CORS, or same-origin serving. Verify what is actually on disk before relying on it, and add a real implementation if the LAN path is used. Never add `CORS_ALLOW_ORIGINS=*` together with credentialed cookies, per the same findings, lines 45 to 51.

## 4. Implementation plan for the implementing lane

### 4.1 Chosen proxy: Caddy

Caddy is the choice. The sibling plans already lean that way (`site-serving-cloud-dashboard-2026-10-30.md:46-49` names Caddy for a standalone proxy: single static binary, one-line `reverse_proxy`). For a bare box with no domain and no TLS, Caddy is still the smaller surface: one binary, one Caddyfile, automatic gzip, no module configuration.

**nginx alternative, rejected.** Installing nginx would work, and the tuning parameters in `server-nginx-tuning-2026-10-30.md` would apply directly. But it means more config for no benefit here: no TLS to terminate, no domain, no upstream pool. If the team insists on nginx, reuse that plan's tuning values and its `trustProxy` rationale, and accept the larger config. Otherwise use Caddy.

### 4.2 Install Caddy on the cloud server

Install from the official package repository (or drop the static binary and run it under systemd). Confirm the version and that the service is enabled at boot:

```sh
caddy version
systemctl enable --now caddy
systemctl status caddy --no-pager
```

Caddy must be the only process bound to port 80. Check before and after:

```sh
ss -ltnp | grep ':80 '
```

If something else already owns :80 (the cloud provider's agent, a leftover web server), stop it or put Caddy on another port only if the provider forwards that port. Do not run two listeners on :80.

### 4.3 Caddyfile: dashboards plus API on one origin

Serve the built dashboards from disk, proxy API routes to `127.0.0.1:3000`, and listen on `:80` with no host name. No host name means no ACME and no TLS attempt, which is what a bare IP needs.

```caddyfile
{
    # No auto_https: this is a plain-IP host with no domain.
    auto_https off
}

:80 {
    encode gzip

    # API surface. Keep these before the static catch-all.
    handle /v1/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle /healthz {
        reverse_proxy 127.0.0.1:3000
    }
    handle /readyz {
        reverse_proxy 127.0.0.1:3000
    }

    # Admin console, built with base /admin/.
    handle_path /admin/* {
        root * /srv/filspay/admin
        try_files {path} /index.html
        file_server
    }

    # Merchant dashboard at the root.
    handle {
        root * /srv/filspay/web
        try_files {path} /index.html
        file_server
    }
}
```

Notes that matter:

- **Admin needs a base-path build.** `apps/admin/vite.config.ts` sets no `base`, and `apps/admin/dist/index.html` references `/assets/...` absolutely. Serving it under `/admin/` without a rebuild yields a blank page. Build it with `vite build --base=/admin/` (or set `base` in the config) and copy the result to `/srv/filspay/admin`. `handle_path` strips `/admin` before the filesystem lookup, so `/admin/assets/x.js` resolves correctly.
- **The merchant dashboard must be built same-origin:** `VITE_API_BASE_URL=` empty. Its dist already uses `/assets/...`, which is fine at the root.
- **Proxy every API prefix, not only `/v1/*`.** The API's routes are registered under `/v1/auth`, `/v1/merchants`, `/v1/transactions`, `/v1/refunds`, `/v1/payment-links`, `/v1/settlement`, `/v1/analytics`, `/v1/reporting`, `/v1/acquirer`, and `/v1/admin` (`apps/api/src/app.ts:54-76`), plus unprefixed health routes (`apps/api/src/app.ts:53`). `/v1/*` plus `/healthz` plus `/readyz` covers all of them today. If a new unprefixed API route appears, add it here or it will be answered by the static handler.
- **No `handle_path` for API routes.** That directive strips the prefix, and Fastify expects `/v1/...` intact. Use `handle`.
- **Ordering:** Caddy's `handle` blocks are mutually exclusive and evaluated in order, so the API handlers must come before the catch-all `handle`.

Validate before reloading:

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### 4.4 App-side: bind localhost and trust the proxy

The proxy is now the public front, so the API should not also be publicly reachable.

- **Bind:** change the API publish in compose from `3000:3000` to `127.0.0.1:3000:3000`, and keep the Caddy upstream at `127.0.0.1:3000`. If the compose network means Caddy (a host process) reaches the container through a published port, localhost publishing is still correct: Docker binds the host loopback only, and Caddy runs on the host.
- **Trade-off, stated plainly:** keeping `0.0.0.0:3000` is only needed for the LAN two-machine demo where browsers on another machine call the API directly. That trade-off weakens the security model below, because a directly reachable API plus `trustProxy: true` accepts spoofed `X-Forwarded-For` (`server-nginx-tuning-2026-10-30.md:442-444`). Prefer loopback-only for judging. If the LAN demo is run, do it before the final deploy, or gate direct access by firewall.
- **Fastify options:** add `trustProxy: true` to the `Fastify({...})` options in `apps/api/src/app.ts`, where the instance is currently built with only `logger: true` (`apps/api/src/app.ts`, see `server-nginx-tuning-2026-10-30.md:128` and the table at line 342). Also set an explicit `keepAliveTimeout` of 60000 ms so Caddy's keep-alive reuse is not cut short by Node's 5 s default (same table). Leave the global `bodyLimit` at its default; multipart routes carry their own limit.
- **Forwarding headers:** Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` by default. No extra config is needed, but verify one request is logged with the real client IP after the change.
- **Cookies over plain HTTP:** with no TLS, `COOKIE_SECURE=true` would prevent the browser from sending the session cookie. Confirm the production value and set `COOKIE_SECURE=false` for this plain-HTTP deployment, or the login will appear to succeed and every subsequent request will be unauthenticated. This is a deployment setting, not a code change, but verify it explicitly.

### 4.5 Ops: health, restart, redeploy without interrupting settlement

- **Health endpoint:** Caddy exposes no public health route of its own here; add one deliberately. The simplest is to let `/healthz` proxy through to Fastify (already in the Caddyfile) and also check Caddy's own process health with `systemctl is-active caddy`. If a proxy-only liveness probe is wanted, add `respond /caddy-health 200`. Document which URL the organiser should poll.
- **Restart policies:** the compose file currently declares none (`ops/docker-compose.yml`, no `restart:` key). Add `restart: unless-stopped` to `postgres`, `api`, `settlement`, and `reporting`. Do not add it to the one-shot `migrate` and `seed` jobs. For Caddy, `systemctl enable caddy` gives boot persistence.
- **Redeploy without interrupting a settlement run:** the PDF requires "how a redeploy avoids interrupting a settlement run". Plan the sequence so settlement is not killed mid-batch:
  1. Rebuild images and run migrations first (`migrate` is a one-shot job).
  2. Restart the API and the dashboards behind Caddy. Caddy keeps listening while the API restarts; brief 502s are acceptable and short.
  3. Leave the settlement daemon alone unless its code changed. If it must restart, wait for the current batch to finish first, or confirm the batch is idempotent and resumable. Do not `docker compose down` during judging; use targeted `up -d --no-deps <service>`.
  4. Verify `/healthz` returns 200 before declaring the redeploy done.
- **One command:** publish the exact redeploy command in the submission document, for example `docker compose -f ops/docker-compose.yml up -d --build api settlement reporting` plus `systemctl reload caddy`. The PDF asks for "the one command (or infrastructure as code) to redeploy", so make it a single copy-paste line or a small script committed to the repo.
- **Secrets:** state the source in the submission document. Today they come from `ops/.env.docker` (compose picks it up automatically, per the header comment in `ops/docker-compose.yml`). Confirm that file is not committed with real secrets, and say where the judging deployment actually reads them from.
- **Diagram:** draw every service and port and mark which face the internet. The minimum shape:

```
internet
  |
  v
:80 Caddy (public)
  |-- static /            -> /srv/filspay/web  (public)
  |-- static /admin/*     -> /srv/filspay/admin (public)
  |-- /v1/*, /healthz, /readyz
  v
127.0.0.1:3000 api (loopback only)
  |
  +--> postgres:5432 (internal compose network; 5432 public only for the LAN demo)
  +--> settlement:8091 (internal, daemon)
  +--> reporting (internal, consumer)
```

Mark only port 80 public for the judged deployment (and SSH 22 for operations). Everything else is loopback or internal.

### 4.6 What the port 80 surface does and does not include

- Public: `/`, `/admin/`, `/v1/*`, `/healthz`, `/readyz`.
- Not public: Postgres 5432, settlement 8091, reporting, the API's raw 3000 port.
- No HTTPS. Judging reaches `http://<server-ip>/`. Say so on the cover page, with `http://` in the URLs, so nobody tries `https://` and hits a connection error.

### 4.7 Optional supplementary: LAN two-machine demo

Only if the demo is split across machines:

- Panels machine: Caddy on port 80 as above, or Vite dev on `--host` for a purely local demo.
- Database machine: Postgres published on `0.0.0.0:5432` so the panels machine can reach it over the LAN. This box was previously verified as the DB machine with 5432 reachable on the LAN.
- **CORS:** the two-machine split means the panels' origin and the API origin can differ if Vite dev is used. That needs real CORS. The "CORS landed" claim is false (section 3.4), so verify with a browser network trace before the demo. Serve the built dashboards through Caddy on the same origin where possible, which removes the need entirely.
- Flag this whole path as unverified until someone runs it on the two machines. It is not the judged path and should not delay the single-server deployment.

## 5. Verification checklist for the implementer

Run these from a machine that is **not** the server where noted. Use the real IP in place of `<server-ip>`.

| Check | Command | PASS looks like |
|---|---|---|
| Proxy is listening on 80 | `ss -ltnp \| grep ':80 '` on the server | `caddy` owns `0.0.0.0:80` (or the public interface) |
| Dashboard HTML | `curl -s http://<server-ip>/` | HTML containing the web app's root element and `/assets/` script tag |
| Admin console | `curl -s http://<server-ip>/admin/` | HTML whose script tag points at `/admin/assets/...` |
| API health through proxy | `curl -s -o /dev/null -w '%{http_code}' http://<server-ip>/v1/health` | `200` |
| Health alias through proxy | `curl -s -o /dev/null -w '%{http_code}' http://<server-ip>/healthz` | `200` |
| API is not public | `curl -s -m 3 http://<server-ip>:3000/v1/health` from outside | connection refused / timeout (PASS). A 200 here is a FAIL for the judged deployment |
| Port 80 reachable from outside | the dashboard and health curl commands above, run off-box | both return content, not connection refused |
| No TLS surprise | `curl -s -m 5 https://<server-ip>/` | expected to fail or warn; judges use `http://` |
| Login works over plain HTTP | browser: log in on `/`, then reload a protected page | session persists; no `Secure` cookie rejection |
| Server stays up | `systemctl is-active caddy`, `docker compose ps` | `active`, all long-running services `Up` with a restart policy shown |
| Redeploy does not kill settlement | run the documented redeploy command during a quiet moment, then `docker compose ps settlement` | settlement stays `Up`, or restarts only when explicitly targeted |
| This lane touched one file | `git -C /home/burglar/Work/Source/fils-pay status --short` | the only line attributable to this lane is `?? docs/plans/hosting-proxy-required-2026-10-30.md` |

Note on the last check: the working tree already contains many modified and untracked files from other lanes. The check is "no *new* change caused by this lane", not "clean tree".

## 6. Open questions and risks

1. **Exact organizer wording behind "proxy is necessary".** The source is the user's message on 2026-10-30, not the PDF text. Confirm what the organizer actually meant before judging: a reverse proxy as an architecture requirement, a specific proxy product, or just "don't expose the app process directly". The plan assumes the first reading and uses Caddy.
2. **Whether HTTPS is expected despite no domain.** Plain HTTP on port 80 is the plan because there is no host name for ACME. If the organizer expects TLS, the options are a self-signed certificate (browser warnings, which look bad to judges) or a provider-supplied hostname. Get a decision early, because it changes the Caddyfile.
3. **Cloud provider port forwarding on the bare IP.** Confirm that inbound port 80 actually reaches the box and is not filtered by the provider's firewall or security group. Also confirm whether port 443 is open, in case TLS becomes a requirement.
4. **What the provider's existing agent does.** The addendum noted a platform agent on the box (`server-nginx-tuning-2026-10-30.md`, addendum section 1). Confirm it does not bind port 80 or restart services underneath the deployment.
5. **Admin base-path build.** Verify that the admin app works under `/admin/` after `--base=/admin/`. If its router also needs a basename, that is an app change owned by another lane.
6. **Cookie security on plain HTTP.** Confirm `COOKIE_SECURE=false` in the judged environment, or login will fail silently after the first request.
7. **Direct API exposure during the LAN demo.** If port 3000 stays public for the two-machine demo, decide whether to firewall it before the final judged state, given the `trustProxy` spoofing risk.

## Appendix — PDF verbatim quotes (verified extraction)

These are the authoritative extraction strings, unchanged. They match `pdftotext` output from `docs/FilsPay_Submission_Guidelines.pdf` (checked in this session).

- Submission table item 4: "Live deployment ... Your running server ... Must stay reachable until judging ends. Put the URLs on the cover page of your submission document."
- "Cover page ... Live URLs for checkout, the merchant dashboard, the admin console and the public API"
- "Architecture and deployment ... A diagram showing every service and port, and which ones face the internet"
- "The one command (or infrastructure as code) to redeploy"
- "Where secrets come from"
- "Health checks, restart policies, and how a redeploy avoids interrupting a settlement run"
- "3. Your server is up, your live links open, and it stays reachable until judging ends."
