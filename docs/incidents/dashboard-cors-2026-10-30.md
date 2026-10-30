# Dashboards are CORS-blocked at runtime

**Status:** Resolved (2026-10-30) — found in the runtime-only sweep.

## Symptom
Opening the merchant dashboard (`apps/web`) or ops console (`apps/admin`)
from its Vite dev server and calling the API fails with the browser blocking
every request ("blocked by CORS"). Nothing unit-testable sees this: route
tests use `app.inject`, which is same-origin.

## Root cause
Both SPA clients call the API cross-origin with cookies
(`credentials: "include"`, `VITE_API_BASE_URL` defaulting to
`http://localhost:3000`), but **the API has zero CORS support** — no
`@fastify/cors`, no headers anywhere. A client comment claimed "CORS is
locked to the two origins in config" (MK) — that configuration never existed.
Runtime probe (before):
- `GET /healthz` with `Origin: http://localhost:5173` → **no**
  `Access-Control-Allow-Origin` header.
- OPTIONS preflight to `POST /v1/auth/login` → **404**
  ("Route OPTIONS:/v1/auth/login not found") — the browser's preflight fails,
  so every dashboard POST is dead on arrival.

## Fix
Dependency-free CORS plugin (`apps/api/src/plugins/cors.ts`, registered via
`fastify-plugin` so the hook reaches top-level routes): replies with `Access-
Control-Allow-Origin` (the exact allowed origin), `Allow-Credentials: true`,
allowed headers (`content-type, idempotency-key, authorization`) and methods,
and answers OPTIONS preflights with `204`. The allow-list is configurable via
`CORS_ALLOW_ORIGINS` (`config.ts`) and defaults to the two Vite origins
`http://localhost:5173,http://localhost:5174` — the exact "two origins" the
comment promised.

## Verification
- New route-level tests (`apps/api/src/plugins/cors.test.ts`): preflight 204
  with headers, simple request carries headers, disallowed origin gets none —
  3/3 pass.
- Runtime probe (after, on the fixed API):
  - `GET /healthz` with `Origin: http://localhost:5173` → **200** with
    `access-control-allow-origin: http://localhost:5173` + credentials.
  - OPTIONS preflight → **204** with the allow headers.
  - `Origin: http://evil.example` → no CORS headers (locked).

## Related variant — LAN / plain-HTTP panel origins (2026-10-30)

Running a panel from a machine’s LAN IP (e.g. `http://10.1.206.54:5174` calling
`http://10.1.206.54:3000`) fails login at the preflight step with
`No 'Access-Control-Allow-Origin' header` because `CORS_ALLOW_ORIGINS` defaults
to the two `localhost` origins. After CORS is fixed, a second failure follows on
plain-HTTP hosts: `cookieSecure` defaults to `true` under `NODE_ENV=production`
(`ops/.env.docker`), so the browser refuses the session cookie and login never
sticks.

Fix (code landed in the CORS plugin, ledger `docs/bugs/L-9.md`):
`CORS_ALLOW_ORIGINS=*` now reflects any Origin header with credentials, so one
deployment works from localhost, LAN IPs or hostnames without enumerating
machines (an explicit allow-list still works). On plain-HTTP hosts set
`COOKIE_SECURE=false`, and point `VITE_ADMIN_API_BASE_URL`/`VITE_API_BASE_URL`
at the LAN API (rebuild or set before `vite dev`).

## Evidence
Commit `(cors) dashboards reach the api cross-origin`, this batch.
