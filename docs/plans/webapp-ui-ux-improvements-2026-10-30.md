# Plan: webapp UI/UX improvements — evaluation + how-to-implement

> Placement note: this plan lives at `docs/plans/` per the planning-lane
> contract (siblings: `io-uring-optimization-2026-10-30.md`,
> `server-nginx-tuning-2026-10-30.md`, `db-query-retention-2026-10-30.md`).
> It is the **how-we-will-do-it** document for improving the UI/UX of the
> two FilsPay web applications, `apps/web` (merchant dashboard + hosted
> checkout) and `apps/admin` (internal ops console). It changes **no code**
> and nothing inside the repo besides this file and its evidence folder;
> sibling lanes own implementation.

| | |
|---|---|
| **Lane** | AI planning lane (webapp UI/UX) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY. Nothing implemented. This lane writes one document + a screenshot evidence folder. |
| **Scope** | Evaluate the current UI/UX of `apps/web` and `apps/admin`, and specify exactly how to improve it. Frozen code (packages/money, apps/settlement/internal/money, test files, v1 API stubs, refund webhook gating) is never touched. |
| **Evidence** | `docs/plans/evidence-webapp-uiux-2026-10-30/*.png` — 25 screenshots of the running apps (desktop 1440×900 and mobile 390×844). |

---

## 1. What this lane found

The two webapps are **visually minimal but functionally sound**. Both are
React 18 + react-router 6 + Vite dev servers (web :5173, admin :5174) that
call `apps/api` over HTTP on :3000 with cookie auth. Neither has a design
system, a UI kit, a CSS framework, or a token file — each ships one small
hand-written stylesheet:

- `apps/web/src/dashboard.css` (311 lines) — namespaced `dash-*` selectors
  only, explicitly so bare-element rules can't leak into the public
  `/pay/:token` checkout page
  (`apps/web/src/dashboard.css:1-14`).
- `apps/web/src/pages/checkout/CheckoutPage.css` (72 lines) — the checkout's
  own isolated look.
- `apps/admin/src/admin.css` (228 lines) — the console's own sheet; even its
  `button` rule is intentionally global, with a comment that a design system
  was "temporary until the design system (Nov 2025)" (`admin.css:106`) that
  never shipped.

**What is already good (do not re-plan):** every monetary value renders
through `formatBhd`/`toFils` from `@filspay/money` per ADR-0001 (no `toFixed`
on money anywhere except MDR percentage display on the admin side); every
page has loading/empty/error states with a friendly `describeError` 403
message; every form has real wrapping `<label>`s, `required`, correct input
types, and disabled-with-progress-text buttons; destructive actions
confirm; the webhook signing-secret "shown once" flow is excellent; the
admin impersonation banner is genuinely impossible to miss (`role="alert"`,
sticky, high contrast) and correctly pauses the whole console; role gating
is UI-only with the server as the true boundary.

Screenshots: `evidence/05-dashboard-transactions.png`,
`evidence/20-admin-merchants.png`, `evidence/16-checkout.png` show the
current state — clean, dense, readable, but plainly unstyled.

---

## 2. Runtime defects at HEAD that block the UI (prerequisites, not this lane's fixes)

These are **runtime-only** defects found during this evaluation. They are
listed here so an implementing lane knows what must be true before UI code
can be *seen* working; each is tracked in the repo's incident/branch
history and fixed on `origin/fix/panel-cors-any-origin`:

| # | Defect | Evidence at HEAD | Fixed on branch |
|---|---|---|---|
| P1 | API has **no CORS**. Both SPAs' `fetch` clients send `credentials: "include"` cross-origin, but at HEAD there is no `@fastify/cors`, no `plugins/cors.ts`, and no CORS hook — every dashboard request is browser-blocked at runtime. The client comment claiming "CORS is locked to the two origins in config" (`apps/web/src/api/client.ts:37`) is false. | `git cat-file -e HEAD:apps/api/src/plugins/cors.ts` → missing; `grep -rniE 'access-control|cors' apps/api/src` → only comments | `33f0201` + `3922867` add `apps/api/src/plugins/cors.ts` and `config.corsAllowOrigins` (default the two Vite origins) |
| P2 | `apps/web` has **no "/" root route**. Opening `http://localhost:5173/` renders react-router's raw `Unexpected Application Error! 404 Not Found` developer screen (evidence `10-web-root.png`). | `grep -nE 'path: "/"' apps/web/src/router.tsx` → none | `33f0201` adds `{ path: "/", element: <Navigate to="/dashboard" replace /> }` |
| P3 | **Migration 0054 is broken on a fresh DB.** `db/migrations/0054_views.sql:21` references `settlement_batch_events`, a table no migration creates (grep across `db/migrations/` finds only that one reference). `bun db/migrate.ts` on an empty DB aborts at 0054. | fresh-migrate run in this lane: `error: migrate: failed applying 0054_views.sql: relation "settlement_batch_events" does not exist` | `0b7e9f4` rewrites the view against `transaction_events.settlement_batch_id` (migration 0023) |
| P4 | HEAD is missing migrations **0073–0077** (0074 widens money columns to BIGINT, etc.) that the fix branch and docs reference. | `ls db/migrations` → ends at 0072 | present on `origin/fix/panel-cors-any-origin` |

**Verification for the implementing lane:** start from the fix branch (or
merge `0b7e9f4`, `33f0201`, `3922867`), then `docker compose -f
ops/docker-compose.yml up` (or the demo box recipe in
`docs/plans/site-serving-cloud-dashboard-2026-10-30.md`), then
`bun db/migrate.ts`, `bun db/seed/index.ts`. Only then do the UI fixes below
become visible in a real browser.

---

## 3. The improvement plan — ordered by impact/effort

Each item: **problem → evidence → how to implement → verify**. Severity is
H/M/L. The first group is cross-cutting and cheap; the second is web-app
specific; the third admin-specific. Every recommendation keeps the frozen
file list untouched and never introduces a new dependency (the repo has
deliberately none in the frontends; the checkout page's brand hint,
overview bar charts etc. are hand-rolled by intent, see
`OverviewPage.tsx:129-137` and `apps/web/src/utils/helpers.ts:96-105`).

### 3.1 Cross-cutting (do first — one small change fixes both apps)

#### C1. Responsive layout at narrow widths — **H**
- **Problem:** neither stylesheet has a single `@media` query (verified:
  `grep -c '@media' apps/web/src/dashboard.css apps/admin/src/admin.css` →
  0/0). Tables are `width: 100%` with fixed columns up to 9 wide
  (`admin.css:141-150`, `dashboard.css:156-163`), `.dash-dl` is a fixed
  `16rem 1fr` grid (`dashboard.css:166`), and the header wraps only because
  of `flex-wrap` on the container. At 390px every list page bursts
  horizontally (the whole `body` scrolls sideways); evidence
  `17-transactions-mobile-390.png` and `18-settlement-mobile-390.png`.
- **How to implement (both apps, same pattern):**
  1. In `apps/web/src/dashboard.css`: add
     ```css
     .dash-main, .admin-main, .checkout-page { min-width: 0; }
     .dash-table, .admin-table { display: block; overflow-x: auto; }
     @media (max-width: 560px) {
       .dash-header, .admin-header { flex-direction: column; align-items: stretch; }
       .dash-dl, .admin-dl { grid-template-columns: 1fr; }
       .dash-form-inline, .admin-form-inline { flex-direction: column; align-items: stretch; }
       .dash-identity, .admin-identity { order: -1; align-self: flex-end; }
     }
     ```
     (namespaced `dash-*` only — remember the checkout-leak rule in
     `dashboard.css:1-14`; put admin rules either in `admin.css` or in a
     new `@media` block there, never bare selectors in `dashboard.css`.)
  2. In `apps/admin/src/admin.css`: same table + header treatment with the
     `admin-*` names.
  3. On the checkout page, keep `max-width: 420px` but add
     `@media (max-width: 480px) { .checkout-form-row { flex-direction: column; } }`
     (evidence `16b-checkout-mobile-390.png` shows the three expiry/cvv
     fields squeezed).
- **Verify:** `bun --cwd apps/web build` and `bun --cwd apps/admin build`;
  then open Transactions and Payments lists at 390px in devtools — no
  horizontal body scroll (only the table itself scrolls), header stacks
  cleanly. Re-capture `17-*`/`18-*` screenshots.

#### C2. Keyboard focus visibility — **M**
- **Problem:** neither sheet defines `:focus-visible`; keyboard users get
  the UA default or nothing (an invisible cursor on a dense money console).
- **How:** add to both stylesheets:
  ```css
  a:focus-visible, button:focus-visible, input:focus-visible,
  select:focus-visible, textarea:focus-visible { outline: 2px solid #1a6db5; outline-offset: 1px; }
  ```
  (in `dashboard.css` keep it class-scoped:
  `.dash-nav a:focus-visible, .dash-button:focus-visible, .dash-form input:focus-visible, ...`
  to respect the checkout-leak rule).
- **Verify:** Tab through a dashboard page and an admin page; a visible ring
  appears on every control.

#### C3. Status colour tells: missing `partially_refunded` — **M**
- **Problem:** `dashboard.css:244-273` colour-groups statuses but has **no
  `.dash-status-partially_refunded`**; `partially_refunded` is a real
  `TransactionStatus` (`types.ts:76-82`) offered in the list filter
  (`TransactionListPage.tsx:10-17`). A partially-refunded txn renders as
  plain black, indistinguishable from "no refund movement".
- **How:** add `.dash-status-partially_refunded { color: #8a5a00; }`
  (or a distinct green-family) beside `.dash-status-refunded`
  (`dashboard.css:271`).
- **Verify:** filter Transactions to `partially_refunded` — chip shows
  colour; admin has no such status (its statuses are rendered through the
  same class list, verify none missing there too).

#### C4. Form errors: banner-only, no inline, no `aria-live`, never cleared on input — **M**
- **Problem:** every form reports via a single top-of-form `<p
  className="dash-error">` (`PaymentLinkCreatePage.tsx:42`, capture form
  `TransactionDetailPage.tsx:183`, admin `AdjustmentImportPage.tsx:140`),
  not associated with its field, not announced, and not cleared when the
  user edits that field.
- **How (small, additive):** in `PaymentLinkCreatePage.tsx`, `LoginPage.tsx`,
  `TransactionDetailPage.tsx` (capture), `WebhookEndpointCreatePage.tsx`,
  and admin `AdjustmentImportPage.tsx`: (1) add `role="alert"` to the error
  `<p>` (one attribute, instantly better); (2) for the field-level guards
  that already exist (e.g. `PaymentLinkCreatePage.tsx:31-35`), show the
  message under the field in addition to the banner; (3) clear the error in
  each field's `onChange`. Full inline-error wiring for every field can be a
  second pass — `role="alert"` + clearing is the 80%. (The admin banner
  lives at `AdjustmentImportPage.tsx:140`.)
- **Verify:** submit an invalid amount → error appears and is announced;
  type in the amount field → error disappears.

#### C5. "Copied" copy-affordance never reverts — **L**
- **Problem:** copy buttons set "Copied" with no timeout and no visible
  failure (`PaymentLinkDetailPage.tsx:78,155`,
  `WebhookEndpointCreatePage.tsx:48,73`).
- **How:** revert after ~2s (`setTimeout`) and set a brief failure state on
  clipboard error.
- **Verify:** click Copy → "Copied" → 2s later back to "Copy secret".

### 3.2 apps/web (merchant dashboard + checkout)

#### W1. `bhd()` crashes the whole page on a negative amount — **H**
- **Problem:** `apps/web/src/format.ts:10-11` calls
  `formatBhd(toFils(amountFils))` without `allowNegative`; `toFils` throws
  `RangeError` on any negative input (`packages/money/src/fils.ts:35-58`).
  Two call sites pass signed values: the event timeline renders
  `bhd(event.amountFils)` for refund events whose DTO documents a negative
  amount (`TransactionDetailPage.tsx:242`, `types.ts` "Negative for refund
  events"), and Reconciliation renders `bhd(report.gapFils)` where the gap
  formula (`ReconciliationPage.tsx:139-141`) is legitimately signed. One
  refund event or a negative gap → whole view throws → blank route.
- **How:** add a sibling helper in `apps/web/src/format.ts`:
  ```ts
  export function bhdSigned(amountFils: number): string {
    return `${formatBhd(toFils(amountFils, { allowNegative: true }))} BHD`;
  }
  ```
  and use it at `TransactionDetailPage.tsx:242` and
  `ReconciliationPage.tsx:115,131`. (Admin already does this correctly in
  its four local `bhd` copies, e.g. `SettlementPage.tsx:15-18`.)
- **Verify:** craft a refund event row or a negative-gap response (QA: patch
  the DB `transaction_events` with a negative `amount_fils`), open the txn
  detail + reconciliation pages — they render `−150.031 BHD` instead of
  dying. `bun --cwd apps/web test` stays green.

#### W2. Settlement "progress" bar is float money math — **M**
- **Problem:** `SettlementBatchDetailPage.tsx:84` computes
  `parseFloat((batch.grossFils / 10000).toFixed(2))` — float math on raw
  fils with an unexplained `/10000` divisor, rendered as a width bar with no
  label (`:90-91`). Violates the repo's own money rule
  (`packages/money/src/fils.ts:6-11`).
- **How:** drop the bar (the page already shows exact Gross/Fee/Net), or if
  a visual is wanted, compute a real integer ratio (e.g.
  `captured-in-batch / total-captured`) and add an `aria-label`. Do not
  derive a monetary figure through `toFixed`/`parseFloat`.
- **Verify:** closed batch detail renders without the mystery bar, or with a
  labelled ratio; `bun --cwd apps/web test` green.

#### W3. Date filters use the UTC day boundary; a comment claims "fixed" but the code is still UTC — **M**
- **Problem:** `apps/web/src/format.ts:27-28` `dayStartIso` returns
  `<date>T00:00:00.000Z` (UTC midnight); the comment thread at `:25-26`
  claims "fixed, uses bahrain time now" — it is not fixed. Settlement dates
  and Reconciliation are explicitly Asia/Bahrain
  (`ReconciliationPage.tsx:21-28`, `SettlementBatchListPage.tsx:29`), so a
  transaction filter and a settlement window can disagree about the same
  calendar day.
- **How:** make `dayStartIso` apply the Bahrain +3h boundary (mirror
  `ReconciliationPage.tsx:27-33`'s `BAHRAIN_OFFSET_MS` — a fixed offset is
  exact, Bahrain has no DST), and update the misleading comment. If a
  frontend-only change cannot be agreed, at minimum correct the comment and
  document the 3h window in the UI helper text.
- **Verify:** filtering "From 2026-10-30" includes a txn at 00:30 Bahrain
  time; `bun --cwd apps/web test` green.

#### W4. Payment-link detail "not found" for links older than the newest 100 — **M**
- **Problem:** there is no merchant-authenticated single-get endpoint, so
  `PaymentLinkDetailPage.tsx:11,46,100` reads the first 100 links and
  `find`s by id; anything older renders "This link is not among your 100
  most recent payment links."
- **How (backend-needed):** add a one-row merchant-scoped
  `GET /v1/merchants/:merchantId/payment-links/:id` (404 on no match) — the
  code itself recommends this — and switch the page to it. The public
  single-token read exists but is not merchant-authenticated.
- **Verify:** open a deep link to a link past row 100 → page renders it.

#### W5. Capture amount input takes raw fils with no validation and no unit help — **M**
- **Problem:** `TransactionDetailPage.tsx:183` label "Amount in fils (blank
  captures everything outstanding)" with `type=number`, no client guard
  (typing `abc` → `NaN`, `1.5` → non-integer fils), while every displayed
  figure is BHD. Payment-link create has the guard
  (`PaymentLinkCreatePage.tsx:31-35`) and a hint (`:28`) — capture doesn't.
- **How:** mirror the create-page pattern: integer + `>0` + `<= outstanding`
  check before submit, and a live hint "10000 fils = 10.000 BHD" like
  `PaymentLinkCreatePage.tsx:28`.
- **Verify:** invalid capture input is blocked client-side with an inline
  message; valid fils value captures.

#### W6. Login friction: mandatory raw merchant UUID — **M**
- **Problem:** `LoginPage.tsx:22,133-139` forces pasting a merchant UUID
  with a placeholder that looks like a real value
  (`00000000-0000-0000-0000-000000000000`). Honest rough-edge documented
  in-code; localStorage recall is the only mitigation.
- **How:** short-term copy only: change placeholder to something visibly
  fake ("paste your merchant id here") and reword the hint. Real fix is
  backend (email lookup or subdomain), explicitly out of scope here — flag
  as a follow-up lane. (Admin login is genuinely strong; do not touch.)
- **Verify:** login page copy reads as instructional, not as a valid id.

#### W7. Overview polling has no visibility guard and no first-load state — **L**
- **Problem:** `OverviewPage.tsx:62` `setInterval(load, 60_000)` runs in
  hidden tabs; first load renders empty table headers with no indicator
  (the memory-leak comments `:37-39` were profiled flat by a sibling —
  don't chase the leak, just the UX).
- **How:** pause the interval when `document.hidden` (a
  `visibilitychange` listener), and render a first-load "Loading…" for the
  three tables.
- **Verify:** background tab stops the polling (network tab); first paint
  shows a loading row.

#### W8. Checkout: raw ISO timestamp and no past-expiry feedback — **L**
- **Problem:** `CheckoutPage.tsx:118` prints `payState.result.paidAt` as raw
  ISO; expiry inputs rely only on native `min`/`max`.
- **How:** format with the same `dateTime()` helper; add a past-expiry
  check with field-level error before submit.
- **Verify:** paid receipt shows localized time; past expiry refuses submit
  with a message.

#### W9. Settlement line items show bare uncoloured status — **L**
- **Problem:** `SettlementBatchDetailPage.tsx` prints `{line.status}` raw in
  the line-items table, unlike every other status display.
- **How:** wrap in `<span className={`dash-status dash-status-${line.status}`}>`.
- **Verify:** batch detail line items show status colour chips.

### 3.3 apps/admin (ops console)

#### A1. Nav-order comment contradicts rendered code — **M**
- **Problem:** `AdminLayout.tsx:10` says "// YA: nav order per Huda's request
  (Credits first)" but lines 33-37 render Merchants, Credits, Settlement
  ops, Import adjustments, Webhook replay — and `/` redirects to
  `/merchants` (`router.tsx:18`). Either the request was Merchants-first
  and the comment is stale, or the request wasn't implemented.
- **How:** confirm the intended order with the product owner (the user), fix
  whichever side is wrong (comment or nav), keep `/` redirect matching the
  first nav item, and add `aria-current="page"` to the active link.
- **Verify:** nav order == comment == landing redirect.

#### A2. Three money-adjacent settlement actions run with no confirmation — **H/M**
- **Problem:** "Run batch" (closes + pays out; blank merchant = all
  merchants) has a one-click trigger with no confirm
  (`SettlementPage.tsx:118-150`); "Recalculate MDR" posts a ledger
  adjustment directly, and the code itself flags a safety question about
  already-PAID batches (`mdrRecalculation.ts:8-9`); "Apply" on adjustment
  CSV imports posts immediately with no preview (`AdjustmentImportPage.tsx:120-135`).
  The two platform-wide rebuilds DO confirm (`SettlementPage.tsx:209-215,282-288`).
- **How:** add the same `window.confirm` (or a small dialog) before: Run
  batch when merchantId is blank, Recalculate MDR, and AdjustmentImport
  Apply (with a row-count/BD-total summary — the client can count non-blank
  lines). The MDR paid-batch question must be resolved with the settlement
  lane before shipping.
- **Verify:** each action now asks before it runs; admin tests green.

#### A3. Default "Run batch" date can be off by one (UTC vs Asia/Bahrain) — **M**
- **Problem:** `SettlementPage.tsx:18-23` `yesterdayIso()` computes local
  yesterday then `toISOString()` (UTC) — at 00:30 Bahrain time this yields
  two days back. MerchantDetail already does it right (`MerchantDetailPage.tsx:20-25`).
- **How:** replace with the local-component formatting like
  `MerchantDetailPage.tsx`.
- **Verify:** at Bahrain 00:30 the default is "yesterday" not "two days ago".

#### A4. Impersonation start is buried at the bottom of a long page — **M**
- **Problem:** "View as merchant" sits last on `MerchantDetailPage.tsx:644-652`
  below five blocks, styled as a plain button.
- **How:** surface it near the merchant identity header with distinct
  treatment + a confirm step (the exit banner's loudness is the standard to
  match).
- **Verify:** a support agent finds the entry without scrolling.

#### A5. One shared `busy` flag freezes every button during any one op — **M**
- **Problem:** `MerchantDetailPage.tsx` throttles rotate/KYC/balance/credit/
  impersonation all through one `busy` state (lines 35, 63-213).
- **How:** per-action busy flags (CreditsPage's per-row `busyId` is the
  in-repo pattern).
- **Verify:** starting a slow op keeps other buttons live.

#### A6. Adjust-balance asks for fils, not BD, with no unit help — **M**
- **Problem:** "Delta (fils, may be negative)" (`MerchantDetailPage.tsx:282-285`)
  forces mental 50 BD → 50000 fils.
- **How:** either accept BD via `parseBhdToFils` (the in-repo parser per
  AGENTS.md) with a live fils preview, or add a visible
  "1000 fils = 1.000 BHD" hint.
- **Verify:** entering 50 BD posts a 50000-fils adjustment.

#### A7. Credits: active tab via disabled + Approve without re-confirm — **M**
- **Problem:** the status tabs disable the active button
  (`CreditsPage.tsx:115-122`) — a disabled button can't be focused and has
  no tab semantics; Approve journals the ledger entry immediately
  (`handleApprove` :78-91) while Reject confirms with a reason.
- **How:** use `role="tablist"/"tab"` + `aria-selected`; add a confirm step
  on Approve showing the exact posted total.
- **Verify:** tabs announce state; Approve asks before posting.

#### A8. Merchant list: search-on-submit vs filters-on-change; support selection dead end — **L/M**
- **Problem:** search applies on submit but status checkboxes fire
  immediately (`MerchantListPage.tsx:108-125` vs `:96-103`); any role can
  select rows but the bulk-approve button's `RequireRole` shows `null` for
  support (`:146`) — a dead-end with rows selected and no action/explanation.
- **How:** one commit model (apply search on change), and give `RequireRole`
  the "finance role required" fallback like every other page; add
  `indeterminate` state to the header checkbox (`:155-157`).
- **Verify:** support sees an explanatory fallback; partial selection shows
  indeterminate.

#### A9. Adjustment-import success notice is unstyled — **L**
- **Problem:** `AdjustmentImportPage.tsx:141` renders the success notice as
  a plain `<p>` while every other page uses `.admin-notice`.
- **How:** add `className="admin-notice"`.
- **Verify:** after an apply, the confirmation reads as feedback.

---

## 4. What NOT to do (guardrails, from the hostile-repo audit)

- **Do not touch** `packages/money/`, `apps/settlement/internal/money/`,
  test files, the v1 API stubs, or `refund.succeeded` webhook eligibility —
  per repo AGENTS.md.
- **Do not add a UI/frontend dependency** (no new npm packages in web/admin):
  every visual in the repo is deliberately dependency-free
  (`OverviewPage.tsx:129`, `formatCardBrandHint` in
  `apps/web/src/utils/helpers.ts:96-105`).
- **Do not add bare-element selectors to `dashboard.css`** — they leak into
  the public checkout page (`dashboard.css:1-14`).
- **Do not "fix" two repo comments that are wrong about the code:**
  `AdminAuthContext.tsx:68` claims the impersonation interval is never
  cleared — it is (`:74-78`); and the localStorage impersonation record is
  display-only (the token is the httpOnly cookie), so no "security fix" is
  needed there.
- **`RefundDrawer.tsx` is parked dead code** (whole file commented out,
  ending `export {};` at `:123`) — do not wire it until the refund API lane
  lands; it currently has no user-facing impact.

## 5. Suggested implementation order

1. **P1–P4** (prerequisites, via the fix branch) — without these no UI
   change is visible.
2. **C1, C2, C3** (responsive, focus, status colour) — one pass per
   stylesheet, both apps.
3. **W1** (negative-money crash) — the only page-crashing defect.
4. **A2** (confirm money-moving admin actions) — operational safety.
5. **W2–W5, A1, A3, A4, A5** (medium cluster).
6. **C4, C5, W6–W9, A6–A9** (polish).

Each item is small and independent; lanes can be parallelized with disjoint
file scopes (web pages vs admin pages vs stylesheets).

## 6. Verification commands for every change

```
bun --cwd apps/web typecheck && bun --cwd apps/web test
bun --cwd apps/admin typecheck
bun --cwd apps/web build && bun --cwd apps/admin build
bun test && cd apps/settlement && go test ./...   # full suite at the end
```

Plus the manual QA from each item's **Verify** line, on the running stack
(see section 2 prerequisites), at 1440px and 390px.
