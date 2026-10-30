# Plan: Vite and toolchain optimization for apps/web and apps/admin

> Placement note: this plan lives at `docs/plans/` per the planning-lane contract, alongside the sibling `server-nginx-tuning-2026-10-30.md` and `io-uring-optimization-2026-10-30.md`. It is the how-to document for "make the two dashboards and the shared build toolchain faster and less fragile". Every item names the file, the current state, the exact edit, the benefit, the risk, and how to prove it worked.

| | |
|---|---|
| **Author** | AI planning lane (synthesis of the web, admin, and toolchain analysis waves) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY. Nothing here is implemented. This lane writes this one file and touches nothing else. |
| **Surfaces** | `apps/web`, `apps/admin`, root toolchain config |
| **Frozen** | `packages/money/` is FROZEN. This plan proposes **no** change inside it. |

---

## Context and intent

Both dashboards run Vite 5.4.21 with the same minimal config shape: `plugins: [react()]` plus a port. That is it. `apps/web` has no proxy, no build block, no host binding. `apps/admin` has the same gaps, and its config still carries a half-written comment.

The measurable state today:

- `apps/web` builds one JavaScript file for the whole app: `apps/web/dist/assets/index-B7c282Hu.js`, 264,332 bytes, no source map.
- `apps/admin` builds one JavaScript file the same way: `apps/admin/dist/assets/index-BzVYwsUN.js`, 258,003 bytes.
- Both routers import every page eagerly, so every dashboard section (and every `@filspay/money` consumer) ships on first load. The public checkout at `/pay/:token` pays for the merchant dashboard it never uses.
- The repo has no CI (`.github` does not exist), no `engines` block, and no `.bun-version`.
- `bun.lock` is the only lockfile, and Vite 5 does not recognize it. Both dev pre-bundle caches carry `"lockfileHash": "e3b0c442"`, the SHA-256 of the empty string, so lockfile-driven re-bundling can never fire.

The intent is to fix the load-time problem first, then the caching and dev-workflow problems, then the toolchain majors. Each section below is ordered by that intent, and the priority table flattens the whole set.

## Priority list (quick wins first)

| # | Change | Surface | Effort | Payoff |
|---|---|---|---|---|
| 1 | Eager dependency pre-bundling (`optimizeDeps.include`) | both apps | 4 lines per config | Removes mid-session dev reloads |
| 2 | Typecheck `vite.config.ts` via `tsconfig.node.json` | admin | new file + one script line | Config typos stop shipping |
| 3 | Explicit `@filspay/money` alias | admin | 5 lines | One resolution source, matches tsconfig |
| 4 | Vendor chunks in the build | admin | one `build` block | Stable long-lived vendor caching |
| 5 | Vendor chunks in the build | web | one `build` block | Same, on the bigger app |
| 6 | Align `build.target` with `es2022` | web | one line | Less downleveling, target consistency |
| 7 | Route-level code splitting | admin | one router file | Initial bundle drops to shell + login |
| 8 | Route-level code splitting | web | one router file | Public checkout stops shipping the dashboard |
| 9 | Dev proxy for same-origin API | web | config + one client line | No CORS or cookie dancing in dev |
| 10 | LAN dev server (`host` + `strictPort`) | web | two lines | Two-machine demo works without flags |
| 11 | Vite 5.4 to 7.3 upgrade | toolchain | dependency bump | Faster transforms, leaner default output |
| 12 | Pin the toolchain (`engines` + `.bun-version`) | toolchain | manifest + new file | Reproducible installs |
| 13 | Add CI | toolchain | new workflow | Typecheck, tests, Go suite on every PR |
| 14 | Vite 8 (rolldown), phase two | toolchain | dependency bump | Faster cold builds, post-demo |

Items 1 to 6 are hours of work and low risk. Items 7 and 8 are the real performance change. Items 9 and 10 are workflow fixes with a security or topology trade-off. Items 11 to 14 are upgrades to schedule, not emergency work.

## Frozen boundary

`packages/money/` is **FROZEN** by repo policy. No item below edits it, moves it, or changes how its decimals are parsed or rounded. Two items touch how the apps *resolve* the package (admin alias, toolchain upgrade), and both point at the same source file the package already exports: `packages/money/package.json` `exports."."` is `./src/index.ts`. That is a consumer-side resolution change, not a change to the package. `apps/settlement/internal/money/` is frozen under the same rule and is out of scope here.

---

## 1. `apps/web`

`apps/web` is the merchant dashboard plus the public checkout page. The checkout is the revenue-critical path and currently shares one bundle with every dashboard screen.

### W1. Route-level code splitting (highest-impact web change)

**(a) File to change:** `apps/web/src/router.tsx`

**(b) Current state:** `router.tsx:2` and `router.tsx:7-19` statically import 14 page components. `router.tsx:22-23` creates the router and puts `<CheckoutPage />` at `/pay/:token`:

```tsx
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";
import { CheckoutPage } from "./pages/checkout/CheckoutPage.js";
...
export const router = createBrowserRouter([
  { path: "/pay/:token", element: <CheckoutPage /> },
```

Consequence: the build emits one file, `apps/web/dist/assets/index-B7c282Hu.js` at 264,332 bytes, so the checkout downloads the transactions, payment-links, webhooks, settlement, reconciliation, and overview pages too.

**(c) Exact change:** turn the 14 page imports into `lazy()` bindings and wrap each render site in `<Suspense>`. Leave the auth provider, guards, `RoleGatedPage`, and `DashboardLayout` eager, because the shell must render before any page chunk arrives.

```tsx
import { createBrowserRouter, Navigate, Outlet, Suspense, lazy } from "react-router-dom";
// ...auth and layout imports stay eager...
const CheckoutPage = lazy(() => import("./pages/checkout/CheckoutPage.js").then((m) => ({ default: m.CheckoutPage })));
const LoginPage = lazy(() => import("./pages/dashboard-login/LoginPage.js").then((m) => ({ default: m.LoginPage })));
// ...same treatment for the other 12 page imports...
```

Then at each render site:

```tsx
{ path: "/pay/:token", element: <Suspense fallback={<div>Loading</div>}><CheckoutPage /></Suspense> },
{ path: "/dashboard/transactions", element: <Suspense fallback={<div>Loading</div>}><TransactionListPage /></Suspense> },
```

The two `RoleGatedPage` routes (`router.tsx:56-61` and the three webhook routes) wrap the lazy element inside the existing gate, so the gate stays synchronous.

**(d) Expected benefit:** the initial download becomes the shell plus the page actually requested. The checkout stops carrying the dashboard, and each dashboard section becomes its own cached chunk fetched on navigation. This is the single largest load-time lever in either app.

**(e) Risk / tradeoff:** one extra request per first navigation. A failed chunk load has no error UI today, because there is no error boundary; add one around the router if that matters. Any future test that renders the router must await the lazy import. `bun test src/` (`apps/web/package.json:10`) only covers pure helpers, so no test change is needed now.

**(f) Verification:** `cd apps/web && bun run build`, then `ls -la dist/assets` must show multiple JS files rather than one. Load `/pay/:token` in the dev server and confirm the network tab fetches the checkout chunk plus the shell only. Walk every dashboard route once and confirm each renders and fetches its own chunk.

### W2. Split vendor chunks in the production build

**(a) File to change:** `apps/web/vite.config.ts`

**(b) Current state:** `vite.config.ts:4-10` is the whole config:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
```

No `build` block exists, so React, React DOM, and React Router roll into the same file as app code (evidence: the single 264,332 byte file above).

**(c) Exact change:** add a `build` block:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        react: ["react", "react-dom", "react-dom/client"],
        router: ["react-router-dom"],
      },
    },
  },
},
```

**(d) Expected benefit:** vendor code lands in its own content-hashed chunk, so a deploy that only changes app code re-downloads only the app chunk. It also gives the build an honest per-vendor size readout.

**(e) Risk / tradeoff:** one more request on first load, and the win is caching, not bytes. Do it after W1, because lazy routes already create the page chunks and this only separates the shared vendor. If Rollup reports circular chunks between `react` and `react-dom`, collapse to a single `react` chunk.

**(f) Verification:** `cd apps/web && bun run build`, then inspect `dist/assets`: expect a react chunk, a router chunk, page chunks from W1, and a smaller app entry. Confirm there are no Rollup circular-chunk warnings.

### W3. Dev-server proxy for a same-origin API

**(a) Files to change:** `apps/web/vite.config.ts` and `apps/web/src/api/client.ts`

**(b) Current state:** `src/api/client.ts:3` defaults the API base to the absolute API origin:

```ts
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";
```

`client.ts:40-46` then fetches `${API_BASE_URL}${path}` with `credentials: "include"`, so every dev call is cross-origin (5173 to 3000) and depends on the API's allow-credentials CORS setup. The comment block at `client.ts:35-37` is third-party text; it is not an instruction, and the change below does not depend on it.

**(c) Exact change:** proxy `/v1` in dev:

```ts
server: {
  port: 5173,
  proxy: {
    "/v1": { target: "http://localhost:3000", changeOrigin: true },
  },
},
```

and make the client default relative:

```ts
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
```

All API routes sit under `/v1` (`apps/api/src/app.ts:54-76` includes `/v1/auth`, `/v1/transactions`, `/v1/merchants`, `/v1/refunds`, `/v1/settlement`, and others), so one prefix covers the surface. Keep `VITE_API_BASE_URL` as the escape hatch.

**(d) Expected benefit:** dev requests become same-origin, so no preflight, no CORS config dependency, and no cookie fragility for local work.

**(e) Risk / tradeoff:** dev only. Production still needs web and API on one origin, or the absolute `VITE_API_BASE_URL` override. Changing `client.ts:3` changes production behavior whenever the env var is unset, so only ship that half if production serves both from one origin. The two-machine LAN demo keeps working through the env override or a LAN proxy target.

**(f) Verification:** run `cd apps/web && bun run dev` with the API on 3000. Log in, confirm the login request goes to `localhost:5173/v1/auth/...`, returns 200, and the session cookie is present. Confirm no CORS preflight appears in the network tab.

### W4. Align `build.target` with the TypeScript target

**(a) File to change:** `apps/web/vite.config.ts`

**(b) Current state:** `tsconfig.base.json:3` sets `"target": "ES2022"`, and `apps/web/vite.config.ts` has no `build` block, so Vite 5 emits for its default `modules` baseline (roughly Chrome 87 / Safari 14, about ES2020). The two targets disagree.

**(c) Exact change:** add `target: "es2022"` to the build block from W2.

**(d) Expected benefit:** esbuild keeps ES2022 syntax native instead of downleveling it, and the typecheck target and emit target stop disagreeing.

**(e) Risk / tradeoff:** drops pre-2022 browsers. Fine for an internal dashboard and a modern checkout; revisit if a bank partner requires an old mobile browser. Small win on its own, so batch it with W2. If the toolchain upgrade (T1) lands first, Vite 7's default target is already much higher, so this line becomes a pin rather than a big change.

**(f) Verification:** `cd apps/web && bun run build`, then `grep -c "class " dist/assets/*.js` or inspect the output for preserved class fields. Confirm the build succeeds with no target warnings.

### W5. Expose the dev server on the LAN

**(a) File to change:** `apps/web/vite.config.ts`

**(b) Current state:** `vite.config.ts:7-9` sets only `port: 5173`. Vite binds localhost by default, so the two-machine demo needs `bun dev --host` flags and fails quietly when someone forgets.

**(c) Exact change:**

```ts
server: {
  port: 5173,
  host: true,
  strictPort: true,
},
```

**(d) Expected benefit:** the dev script (`apps/web/package.json:7`) is reachable from the second machine immediately, and `strictPort` fails loudly instead of drifting to 5174 and invalidating CORS allowlists or demo bookmarks.

**(e) Risk / tradeoff:** binds the dev server to every interface, so anyone on the network can load source modules from it. Trusted LAN only; add firewall rules for anything less. This is convenience, not performance, and is the lowest web priority.

**(f) Verification:** `cd apps/web && bun run dev`, then from another machine on the LAN, open `http://<lan-ip>:5173` and log in through W3's proxy or the env override.

---

## 2. `apps/admin`

`apps/admin` already uses the React Router data router (`createBrowserRouter` in `src/router.tsx`, rendered by `<RouterProvider router={router} />` at `src/main.tsx:16`), so route-level lazy loading needs no migration.

### A1. Route-level code splitting (highest-impact admin change)

**(a) File to change:** `apps/admin/src/router.tsx` (optionally a fallback in `src/main.tsx`)

**(b) Current state:** `router.tsx:4-10` statically imports all 7 pages:

```ts
import { AdjustmentImportPage } from "./pages/adjustments/AdjustmentImportPage.js";
import { CreditsPage } from "./pages/credits/CreditsPage.js";
import { LoginPage } from "./pages/login/LoginPage.js";
import { MerchantListPage } from "./pages/merchants/MerchantListPage.js";
import { MerchantDetailPage } from "./pages/merchants/MerchantDetailPage.js";
import { SettlementPage } from "./pages/settlement/SettlementPage.js";
import { WebhookReplayPage } from "./pages/webhooks/WebhookReplayPage.js";
```

Every route at `router.tsx:14` and `router.tsx:26-32` uses those eager components, so all 7 pages plus their API clients and money imports share the initial bundle (build output: `apps/admin/dist/assets/index-BzVYwsUN.js`, 258,003 bytes).

**(c) Exact change:** replace the static imports with route-level `lazy` modules that adapt the named exports:

```ts
export const router = createBrowserRouter([
  {
    path: "/login",
    lazy: () => import("./pages/login/LoginPage.js").then((m) => ({ Component: m.LoginPage })),
  },
  {
    element: (
      <RequireAdminAuth>
        <AdminLayout />
      </RequireAdminAuth>
    ),
    children: [
      { path: "/", element: <Navigate to="/merchants" replace /> },
      { path: "/merchants", lazy: () => import("./pages/merchants/MerchantListPage.js").then((m) => ({ Component: m.MerchantListPage })) },
      { path: "/merchants/:id", lazy: () => import("./pages/merchants/MerchantDetailPage.js").then((m) => ({ Component: m.MerchantDetailPage })) },
      { path: "/credits", lazy: () => import("./pages/credits/CreditsPage.js").then((m) => ({ Component: m.CreditsPage })) },
      { path: "/settlement", lazy: () => import("./pages/settlement/SettlementPage.js").then((m) => ({ Component: m.SettlementPage })) },
      { path: "/adjustment-imports", lazy: () => import("./pages/adjustments/AdjustmentImportPage.js").then((m) => ({ Component: m.AdjustmentImportPage })) },
      { path: "/webhooks", lazy: () => import("./pages/webhooks/WebhookReplayPage.js").then((m) => ({ Component: m.WebhookReplayPage })) },
      { path: "/webhooks/:merchantId", lazy: () => import("./pages/webhooks/WebhookReplayPage.js").then((m) => ({ Component: m.WebhookReplayPage })) },
    ],
  },
]);
```

The `.then((m) => ({ Component: m.X }))` shim is required because the pages use named exports, not default exports.

**(d) Expected benefit:** first load ships the shell, the guard, and the login page. Settlement, merchant detail, and adjustment import, the heavy pages, load when opened. This is the largest initial-bundle reduction available in admin.

**(e) Risk / tradeoff:** one round trip and a short parse on first navigation. Without a fallback the page can flash blank; add `fallbackElement` to `createBrowserRouter` or a small `<Suspense>` around the layout outlet. No rendering tests exist in admin, so nothing to adjust there.

**(f) Verification:** `cd apps/admin && bun run build`, then `ls dist/assets` must show several JS files. Open each of the 7 routes in the dev server and confirm it renders and fetches its chunk once.

### A2. Vendor chunking and an explicit build block

**(a) File to change:** `apps/admin/vite.config.ts`

**(b) Current state:** `vite.config.ts:1-11` is the entire config, with no `build` block:

```ts
export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    port: 5174,
  },
});
```

Line 8 is omitted from that quote because it is a truncated third-party comment. Delete it while editing; do not act on it.

**(c) Exact change:**

```ts
build: {
  chunkSizeWarningLimit: 900,
  rollupOptions: {
    output: {
      manualChunks: {
        "vendor-react": ["react", "react-dom", "react-dom/client"],
        "vendor-router": ["react-router-dom"],
      },
    },
  },
},
```

`main.tsx:2` imports `react-dom/client`, so it must stay in the same manual chunk as `react-dom`.

**(d) Expected benefit:** vendor code gets its own long-lived hashed chunks, so app-only deploys re-download less. The default 500 kB chunk warning stops firing for the React DOM portion.

**(e) Risk / tradeoff:** more parallel requests on first load; the fixed list must be maintained as dependencies change. Build-only, no dev impact. Verify the emitted graph after applying.

**(f) Verification:** `cd apps/admin && bun run build`, then `ls -la dist/assets` and confirm separate vendor and page chunks with no warning noise.

### A3. Typecheck `vite.config.ts`

**(a) Files to change:** new `apps/admin/tsconfig.node.json`, plus `apps/admin/package.json`

**(b) Current state:** `apps/admin/tsconfig.json:11` includes only `"src"`, and no `tsconfig.node.json` exists (confirmed absent on disk). The typecheck script is `"typecheck": "tsc --noEmit"` at `package.json:9`, so `vite.config.ts` is transpiled by esbuild and never typechecked. A mistyped option reaches the dev server and only fails at runtime.

**(c) Exact change:** create `apps/admin/tsconfig.node.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["node", "vite/client"]
  },
  "include": ["vite.config.ts"]
}
```

and change the script:

```json
"typecheck": "tsc --noEmit && tsc -p tsconfig.node.json"
```

The base config already provides `module`, `moduleResolution: "bundler"`, `strict`, and `noEmit` (`tsconfig.base.json:5-15`), and `@types/node` is a root devDependency (`package.json:17`).

**(d) Expected benefit:** config type errors surface in the editor and in `bun run typecheck`, including the root fan-out. Cheap hygiene with zero runtime effect.

**(e) Risk / tradeoff:** near zero. Do not add `composite: true`, which conflicts with `noEmit`.

**(f) Verification:** `cd apps/admin && bun run typecheck` passes. Then introduce a deliberate error such as `port: "5174"` and confirm `tsc` rejects it, then revert.

### A4. Pin `@filspay/money` resolution with an alias

**(a) File to change:** `apps/admin/vite.config.ts`

**(b) Current state:** `apps/admin/tsconfig.json:7-9` maps the package to source:

```json
"paths": {
  "@filspay/money": ["../../packages/money/src/index.ts"]
}
```

`vite.config.ts` has no `resolve` block. Vite finds the same file through the workspace symlink plus `packages/money/package.json` `exports` (`".": "./src/index.ts"`), a second, independent chain. Four admin pages import the package: `AdjustmentImportPage.tsx:2`, `CreditsPage.tsx:3`, `MerchantDetailPage.tsx:3`, `SettlementPage.tsx:2`.

**(c) Exact change:**

```ts
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@filspay/money": fileURLToPath(new URL("../../packages/money/src/index.ts", import.meta.url)),
    },
  },
  // server and build blocks as above
});
```

`fileURLToPath` is required because the config is ESM (`package.json:5` is `"type": "module"`), so `__dirname` is undefined.

**(d) Expected benefit:** one explicit resolution source that matches `tsconfig.json` exactly. A hoist or relink cannot silently change what the app compiles.

**(e) Risk / tradeoff:** binds to `packages/money`'s source layout, which tsconfig already does. If the package ever ships `dist/`, both places must change together. `packages/money` itself is untouched.

**(f) Verification:** `cd apps/admin && bun run typecheck && bun run build`, then confirm the build has no unresolved import for `@filspay/money`. Open the credits page in dev and check the money formatting still renders.

### A5. Eager dependency pre-bundling

**(a) File to change:** `apps/admin/vite.config.ts` (the same edit also goes into `apps/web/vite.config.ts`, see T4)

**(b) Current state:** `vite.config.ts` has no `optimizeDeps` block, and `apps/admin/node_modules/.vite/deps/_metadata.json` records `"lockfileHash": "e3b0c442"`. The cache already contains react, react-dom, react-dom/client, and react-router-dom, so the include list matches reality.

**(c) Exact change:** add `optimizeDeps: { include: ["react", "react-dom", "react-dom/client", "react-router-dom"] }` to the config.

**(d) Expected benefit:** the four always-imported deps are pre-bundled at cold start, which removes the mid-session dependency reload during a demo walk.

**(e) Risk / tradeoff:** the list needs maintenance as direct deps change, and `--force` costs one slower startup. Dev only.

**(f) Verification:** delete `apps/admin/node_modules/.vite`, start the dev server, and confirm it does not log a mid-session "optimized dependencies changed" reload during a normal page walk.

---

## 3. Toolchain root

### T1. Upgrade Vite 5.4 to 7.3

**(a) Files to change:** `apps/web/package.json`, `apps/admin/package.json`

**(b) Current state:** `apps/web/package.json:23` declares `"vite": "^5.4.11"`; `apps/admin/package.json:22` declares the same. Installed is 5.4.21, with `@vitejs/plugin-react` 4.7.0 (declared `^4.3.4` at `apps/web/package.json:21` and `apps/admin/package.json:20`). The plugin's peer range accepts Vite 4 through 7, so no plugin swap is needed.

**(c) Exact change:** set `"vite": "^7.3.7"` in both manifests, optionally tighten the plugin to `"^4.7.0"`, then from the repo root run `bun install`.

**(d) Expected benefit:** Vite 7 uses a much newer esbuild line than Vite 5's `^0.21.3`, so transforms and dependency optimization get several release cycles of performance work. Its default build target is `baseline-widely-available`, which downlevels less than Vite 5's `modules`. Vite 5 is also at the end of its minor line.

**(e) Risk / tradeoff:** Node 18 is no longer supported; engines require `^20.19.0 || >=22.12.0`, and this machine runs v26.13.0. Teammates below 20.19 will fail. The configs are minimal, so migration surface is near zero; smoke-test both dev servers and HMR.

**(f) Verification:** `bun install`, then `bun run --filter '@filspay/admin' build`, `bun run --filter '@filspay/web' build`, and `bun run typecheck`. Start both dev servers and confirm HMR still updates a page.

### T2. Add CI

**(a) File to change:** new `.github/workflows/ci.yml` (the `.github` directory does not exist)

**(b) Current state:** `ls -a .github` fails with "No such file or directory". The repo's own rule is to run the full suite after every change (`AGENTS.md`), but nothing enforces it. Root scripts already exist to consume: `package.json:11` runs `bun run --filter '*' typecheck` plus the db and scripts projects, and `package.json:12` runs the workspace tests plus `scripts/`.

**(c) Exact change:** create:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test
      - run: cd apps/settlement && go test ./...
```

`ubuntu-latest` avoids the documented Windows timezone flakiness in the settlement tests.

**(d) Expected benefit:** every push and PR verifies typecheck, the bun suite, and the Go suite. `--frozen-lockfile` makes installs deterministic.

**(e) Risk / tradeoff:** the first run may expose latent failures in the root scripts, including the `tsc -p db` and `tsc -p scripts` steps. Validate on a branch before enabling on `main`. Requires GitHub Actions to be on for `github.com/ali-afk/fils-pay`.

**(f) Verification:** open a draft PR and confirm the workflow is green from a clean checkout, including the Go step.

### T3. Pin the toolchain

**(a) Files to change:** `package.json`, new `.bun-version`

**(b) Current state:** `package.json:1-25` has no `engines` block (`grep engines` returns nothing), and there is no `.bun-version` or `.nvmrc`. The machine runs bun 1.4.4 and node v26.13.0, while declared ranges have already drifted ahead of install: TypeScript is declared `^5.6.3` (`package.json:19`) but 5.9.3 is installed, and plugin-react is declared `^4.3.4` but 4.7.0 is installed.

**(c) Exact change:** add after `"version": "0.1.0",`:

```json
"engines": {
  "node": ">=20.19.0",
  "bun": ">=1.4.0"
},
```

and create `.bun-version` containing `1.4.4`. In CI, switch to `bun-version-file: .bun-version`.

**(d) Expected benefit:** one declared contract for the runtime floor, one pinned bun version for CI, and no more "works on my machine" drift.

**(e) Risk / tradeoff:** `engines` is advisory unless `engine-strict` is set. Enabling strict mode blocks older toolchains on purpose. A pinned `.bun-version` means teammates upgrade bun.

**(f) Verification:** `bun install` still succeeds, CI reads the version file, and a machine below node 20.19 gets the declared warning.

### T4. Eager dependency pre-bundling in both apps

**(a) Files to change:** `apps/web/vite.config.ts`, `apps/admin/vite.config.ts`

**(b) Current state:** both configs are `plugins: [react()]` plus `server.port`. Neither sets `optimizeDeps`. Their caches already contain the four browser deps, and both `_metadata.json` files record `"lockfileHash": "e3b0c442"`, the SHA-256 of the empty string. Vite 5 only hashes npm/yarn/pnpm lockfiles, so `bun.lock` is invisible to it and the lockfile-change trigger is inert.

**(c) Exact change:** in both configs:

```ts
optimizeDeps: {
  include: ["react", "react-dom", "react-dom/client", "react-router-dom"],
},
```

Plus a process rule: after any `bun install` or `bun update` that changes React or React Router, start the dev server once with `bunx vite --force` (or delete `apps/*/node_modules/.vite`) instead of relying on lockfile invalidation.

**(d) Expected benefit:** the four always-imported deps are pre-bundled at cold start, so a session does not get the "optimized dependencies changed, reloading" hiccup mid-demo. The include list also makes the dep set explicit.

**(e) Risk / tradeoff:** the list needs maintenance as direct deps change. `--force` costs a few seconds once. Dev only, no production effect. Do not extract a shared config for two apps.

**(f) Verification:** delete `apps/web/node_modules/.vite` and `apps/admin/node_modules/.vite`, start both dev servers, load the login page and one dashboard page in each, and confirm no dependency-changed reload appears.

### T5. Vite 8 with rolldown, phase two

**(a) Files to change:** `apps/web/package.json`, `apps/admin/package.json`

**(b) Current state:** the registry's latest Vite on 2026-10-30 is 8.3.5, which ships rolldown and lightningcss. `@vitejs/plugin-react` latest is 6.1.2, with peer dependency `vite ^8.0.0`. The installed plugin 4.7.0 peers up to Vite 7 only, so Vite 8 and plugin-react 6 must move together.

**(c) Exact change:** after T1 is green and CI is running, set `"vite": "^8.3.5"` and `"@vitejs/plugin-react": "^6.1.2"` in both apps, then `bun install`.

**(d) Expected benefit:** bundling moves from rollup plus esbuild to rolldown, which the Vite team positions as substantially faster on cold builds and dev dependency optimization. Default transforms use oxc and LightningCSS.

**(e) Risk / tradeoff:** a bundler swap on the hottest path. The repo touches almost no plugin ecosystem, only plugin-react, which limits exposure. Expect lockfile churn from the new peers. Schedule after the demo, gated on CI.

**(f) Verification:** repeat the T1 verification plus `bun run test`, and compare cold `vite build` wall time before and after on the same machine.

---

## 4. What this lane will not do

- No edits outside `docs/plans/vite-toolchain-optimization-2026-10-30.md` by this planning lane.
- No change to `packages/money/` or `apps/settlement/internal/money/`.
- No test file edits, no monetary column changes, no `v1/` stub changes, no `WEBHOOK_ELIGIBLE_EVENT_TYPES` change.
- No Turbo, Nx, eslint, or prettier introduction. Those are new tooling, not optimization of existing tooling.
- No cache-directory relocation. `.vite` already sits under the gitignored `node_modules/` (`.gitignore:1`).
- No attempt to make `client.ts` relative in production without confirming production serves web and API from one origin.

## 5. Risks and fail-safes

- **The lazy split lands half-done:** a route missing its `Suspense` or `lazy` wrapper throws at render. Mitigation: the per-route walk in each item's verification, plus a build whose `dist/assets` clearly holds several chunks.
- **Proxy changes production behavior:** `client.ts:3` defaulting to `""` is safe only same-origin. Mitigation: gate that line on the deployment topology, and keep `VITE_API_BASE_URL` as the documented override.
- **`host: true` exposes source:** the dev server serves modules and has no auth. Mitigation: trusted LAN only, firewall for anything else.
- **Target jump drops old browsers:** `es2022` and Vite 7's baseline both retire older engines. Mitigation: confirm the checkout's supported browser list before shipping W4 or T1.
- **Upgrade churn before the demo:** T1 changes the lockfile and the toolchain. Mitigation: land items 1 to 8 first, do T1 on a branch with CI green, and keep the Vite 8 move (T5) post-demo.
- **No measurable win:** if the built bundle does not shrink after W1 and A1, stop and inspect the chunk graph rather than tuning further. A documented "no change" is an acceptable result.

## 6. VERIFY (plan-time verification and post-implementation checks)

Verified against disk on 2026-10-30 while writing this plan:

| Claim | Evidence checked |
|---|---|
| Both Vite configs are minimal, with the ports and the third-party comments | `apps/web/vite.config.ts:1-10`, `apps/admin/vite.config.ts:1-11` |
| Web router is fully eager | `apps/web/src/router.tsx:2`, `:7-19` (14 page imports), `:22-23` |
| Admin router is fully eager, 7 pages | `apps/admin/src/router.tsx:4-10`, `:14`, `:26-32` |
| Admin already uses the data router | `apps/admin/src/main.tsx:16` |
| Web client uses an absolute API base and credentials | `apps/web/src/api/client.ts:3`, `:40-46` |
| API routes live under `/v1` | `apps/api/src/app.ts:54-76` |
| Web build is one 264,332 byte JS file | `apps/web/dist/assets/index-B7c282Hu.js`, `apps/web/dist/index.html` script tag |
| Admin build is one 258,003 byte JS file | `apps/admin/dist/assets/index-BzVYwsUN.js` |
| No source maps in either dist | `find apps/web/dist apps/admin/dist -name '*.map'` returns 0 |
| Installed versions | vite 5.4.21, plugin-react 4.7.0, react 18.3.1, react-dom 18.3.1, react-router-dom 6.30.6 |
| Money package resolves to source | `packages/money/package.json:6-9` |
| Admin has no `tsconfig.node.json` | absent on disk (and web has none either) |
| Lockfile hash is the empty-string SHA-256 | both `node_modules/.vite/deps/_metadata.json` files |
| No CI, no engines, no `.bun-version` | `.github` absent, `grep engines package.json` empty, `.bun-version` absent |
| Toolchain versions | bun 1.4.4, node v26.13.0, TypeScript 5.9.3, tsx 4.23.13, esbuild 0.28.2 |

Two corrections to the wave reports, applied above:

1. The web report says 16 eager page imports. Disk shows 14 (`router.tsx:2` plus `:7-19`). This plan uses 14.
2. The admin report quotes `apps/admin/vite.config.ts:8`, a truncated comment about storybook. This plan refers to that line without reproducing it, and the instruction stands: delete it when editing the config.

Post-implementation gate, run in this order:

1. `bun install` (after T1 and T3).
2. `bun run typecheck` (covers A3, and both apps after T1).
3. `bun run --filter '@filspay/web' build` and `bun run --filter '@filspay/admin' build`.
4. `ls -la apps/web/dist/assets apps/admin/dist/assets`: several JS chunks per app, each vendor chunk present, and no single monolith around 250 kB.
5. Start both dev servers, walk every route, confirm lazy chunks load once and no dependency reload fires.
6. Web only: log in through the `/v1` proxy, confirm same-origin requests and the session cookie.
7. CI green on a branch, including `cd apps/settlement && go test ./...`.
8. Confirm `git status` shows no change under `packages/money/`.

## 7. Sources

This plan synthesizes three read-only analysis reports written the same day:

- `/tmp/tmp.rB7bP7JniP/waves/vite-toolchain-2026-10-30/web.md` (apps/web)
- `/tmp/tmp.rB7bP7JniP/waves/vite-toolchain-2026-10-30/admin.md` (apps/admin)
- `/tmp/tmp.rB7bP7JniP/waves/vite-toolchain-2026-10-30/toolchain.md` (root toolchain)

Sibling shape reference: `docs/plans/server-nginx-tuning-2026-10-30.md` and `docs/plans/io-uring-optimization-2026-10-30.md`.

Plan: .omo/plans/vite-toolchain-optimization.md
