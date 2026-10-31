# FilsPay — Judge Speaker Card (quick glance) · *addressed edition*

**Date:** 2026-10-31 · **Same layout as `judge-speaker-card.md`, with Q&A
adjustments inline** (VU meaning, load-test mechanics, batch vs interactive,
group commit, keep-alive, FP-209, bug-letter legend). Companion to
`docs/plans/judges-roundup-2026-10-31.md` (canonical, full-evidence). Every
number is sourced there.

---

> **THE NUMBER JUDGES ASK FOR — requests/s**
> - **Measured today (FP-209): ~34 req/s** at 28 VUs — a **floor, not a ceiling** (0 errors, RSS 236/512 MB, box never saturated).
> - **Estimated after the planned features:** ~**100–300 req/s** (0.5 vCPU) · ~**300–600 req/s** (1 vCPU host).
> - **Binding limit today:** `pgPoolMax = 5` → ~**120 req/s** theoretical. Everything is **DB-bound** at the real ceiling.
> - *Estimate, not measurement — reasoning in C-12 below.*
> - **Vocabulary to say it:** VU = virtual user · **28 VUs → 20,471 requests** in 10 min (**~731 requests per VU**, ~**1.2 req/s per VU**) · one request is always handled by **one** VU · **one k6 machine** ran all VUs (k6 runs them as threads in one process — no distributed load).

---

# PART B — The bugs, one glance each

Parts B and C of this card are the compressed view — the roundup holds the full
prose. **C = money-loses-true** — volunteer those first ⚠.

**Bug-letter legend:** letter = category, number = ordinal in it: **C** money · **H** security/auth · **P** payment links · **M** money-path · **R** reliability · **S** validation · **L** operational · **F** reporting — plus **B** (B1–B24) = the *fixed-work register* in `EXPLANATIONS.md`. Sums to **61** open.

## Critical money (C) — six that move money wrong ⚠

- **C-1** — payout math still `float32` `[V] payable.go:10-12`. ≥ **2^24 fils (16,777.2 BHD)** drifts a fils: gross 16,777,200 → **16,777,199**. Same error in batch + ledger + statement + bank file. Fix = 1 line.
- **C-2** — refunds never reach settlement `[V]`. `settlement_batch_id` stays NULL; admin calls `/internal/refund-adjustment`, which **doesn't exist**. Merchant paid full capture **and** takes the refund debit → **double-pay; month can't reconcile**.
- **C-3** — summary double-counts multi-capture `[U] query.ts:370-393`. 60,000 + 40,000 shows **200,000** (the "38% > batches" mystery).
- **C-4** — reconciliation omits the payout debit `[U] query.ts:282-353`. Paid batch → gap **negative even when money ties**.
- **C-5/C-6** — capture discounts wrong on the link path / only the latest capture `[U]`. Discounted merchants overcharged.

## Security & auth (H) — highlights

- **H-1** — key rotation never revokes the old key `[U]` · **H-2/H-3** — link endpoint leaks key prefix/hash; **any** key bypasses link expiry `[U]` · **H-4** — impersonation can write `[U]+[P]`.
- **H-6** ⚠ — OTP looked up by **email only** → can mail the *wrong tenant's* code `[P]`. Gate before production email.
- **H-7** — OTP counter is check-then-increment, **not atomic** `[P]` → parallel burst defeats the 5-guess cap (**see C-13, reproduced**). Fix = one atomic statement.
- **H-8** — OTP resend resets the guess budget `[P]` · **H-9** — OTP success doesn't reissue cookie (10-min logouts) `[P]` · **H-10** — session fixation on promotion `[P]`.
- **H-12** — acquirer callbacks unsigned by default, no replay window `[P]` · **H-13** — inbound signature over re-serialized, not raw bytes `[P]`.

## Payment links (P)

- **P-1** — link flow not one transaction: crash/finalize can **charge twice** `[P]+[U]` · **P-2** — no `Cache-Control: no-store` · **P-3** — over-reveal · **P-4** — support can move money. `[U]`

## Money-path (M) — highlights

- **M-5** — rebuild-balances no row locks `[P] S9` · **M-8** — MDR recalc ignores fee schedules + volume tier `[U]` · **M-11** — partial-refund fee reversals over/under-sum `[U]`. Rest (M-1..4,6,7,9,10,12) in appendix.

## Reliability (R) — highlights

- **R-1** — reporting cursor no row lock → **double-apply** `[P] R12` · **R-3** — duplicate webhook deliveries with >1 replica `[U]+[P] O13` · **R-6** — endpoint deletion 500s `[P] O10` · R-4/5/7 in appendix.

## Validation (S) — highlights

- **S-3** — CSV export **formula injection** (`=`/`+` cells unescaped) `[U]` · **S-2** — KYC thumbnail no pixel cap: an **8 MB PNG → DoS the 512 MB box** `[U]` · **S-4/S-7** — invalid input → 500s `[V]`. Rest in appendix.

## Operational (L) — highlights

- **L-6** — adjustment CSV re-import duplicates every row (happened in Aug) `[U]` · **L-7** — progress bar = `gross/10000` (20,000 BD shows **200%**) `[V]` · **L-8** — `amountFils: NaN` → 500 `[V]` · **L-9** — CORS — **FIXED** (Part D).

## Reporting (F)

- **F-2** — refunds bucketed by outbox `created_at`, not the refund's `occurred_at` `[U]+[P]`.

---

# PART C — Performance, the how and the why

Status: **SHIPPED** (in code) / **MEASURED** (evidence) / **PLANNED** (spec'd) /
**REJECTED** (decided against). Numbers are evidence — say them confidently.

### C-1 · Postgres `shared_buffers` 32→128 MB — **MEASURED** ⚠ *the one proven win*

- Summary page was a **400k-row scan**. Page **3–6 s** (sample 3.4 s) → **410 ms warm** (~8×).
- Not in compose yet — **set it first on the demo box.**

### C-2 · FP-209 load test — **MEASURED**

- **FP-209 = "FilsPay issue #209"** — the load-test ticket (same tracker as FP-187 March close, FP-212 refunds). `fp-209-loadtest-2026-09.md` is its writeup; its numbers are the **no-regression gate** for every perf plan.
- k6, **28 VUs**, 10 min, 0.5 vCPU/512 MB · **0 errors** · peak RSS **236/512 MB**.
- list **41/112 ms** · summary **88/240 ms** · export **2.21 s/4.18 s**. Every plan gates on these.
- **How the load was driven:** one k6 instance (all VUs run as threads in one process) · **20,471 requests / 600 s = ~34 req/s** · **~731 requests per VU** (~1.2 req/s per VU) · one request → one VU.

### C-3 · Why not nginx — **DECISION**

- Live API + 2 SPAs, not a static site; box already behind managed nginx + Cloudflare.
- Serve dashboards **same-origin from Fastify :3000**; **Caddy** only on a bare IP :80 (`keepAliveTimeout 60000`).

### C-4 · Why Postgres 16 → 18 — **PLANNED (NOT shipped)**

- **Batch vs interactive:** "**interactive**" = the online, latency-sensitive path (dashboard lists, summary page, checkout) — index-driven small reads, p50 tens–hundreds of ms; "**batch**" = the offline bulk path (settlement close, fee runs, **COPY** exports, reconciliation, VACUUM) — sequential scans over big ranges, minutes are fine.
- PG18 `io_method=io_uring` speeds the **batch** path (settlement/reporting seq scans, COPY, VACUUM) — **not** the interactive path. The levers don't overlap.
- Gate: seccomp blocks `io_uring_setup` — needs a compose override + benchmark first.

### C-5 · Why Bun — **PLANNED/DECISION**

- io_uring event loop; ~**2–2.5× faster startup**, lower memory. Compose already runs `bun`. Go io_uring rejected (stdlib won't integrate).

### C-6 · Index + outbox retention — **PLANNED**

- (1) `transaction_events(transaction_id, event_type)` — kills a **402,911-row seq scan**.
- (2) `purge_outbox.ts` — `outbox_events` grows without bound; `processed_at` written by nobody; 2 GB disk.

### C-7 · fast-json-stringify vs buffer-direct — **REJECTED with better answer**

- Buffer-direct rejected: hot reads are **DB-bound, not serialization-bound**. Adopt Fastify **response schemas** (`fast-json-stringify`, **2–5×**), route-by-route from `GET /v1/transactions`.

### C-8 · The rejected trio — say it proudly

- **Completion batching ("group commit")** — REJECTED, 4 reasons: (1) **HTTP is synchronous** — a `200` must mean durable, so batching either delays responses or breaks the guarantee; (2) **widens/lengthens row locks** — one slow member holds everyone open; (3) **re-implements the outbox** — async work already flows through the transactional outbox + dispatcher; (4) **nothing to unlock** — ceiling is `pgPoolMax = 5`, not commit fsync cost (Postgres batches WAL flushes itself).
- **Connection-state compaction** — NOT-APPLICABLE: we own zero per-connection structures (pg/pgx/node carry it).
- **Idle-connection shedding** — PLANNED (insurance): pools shed via `idleTimeoutMillis` already; **LISTEN clients never shed** (that incident!).

### C-9 · LISTEN reconnect — **SHIPPED on the fix branch** `[V] a808bf7`

- Dispatcher LISTEN client reconnects on error/end → delivery latency back to **NOTIFY speed**, not the 5–15 s poll tick.

### C-10 · Frontend toolchain — **PLANNED**

- Split the **one 258–264 KB JS per dashboard** — the public checkout pays for the merchant dashboard it never uses.
- Found a real bug: both Vite caches pin `lockfileHash: e3b0c442` = SHA-256 of the *empty string* → re-bundling could never fire.

### C-11 · Keep-alive coherence — **PLANNED**

- **Plain version:** HTTP reuses idle TCP sockets; each side has an *idle timeout*. Fastify closes after **5 s**; the Caddy proxy keeps them far longer — so Caddy thinks a socket is reusable 30 s in, Fastify killed it at 5 s, and the next request pays a reconnect.
- **Fix:** make both ends agree — `keepAliveTimeout 60000` (Caddy) / `proxy_set_header Connection ""` + `proxy_http_version 1.1` (nginx). A *mismatch* fix, not a throughput lever.

### C-12 · Expected req/s after the missing features — **ESTIMATE, not measured**

- **34 req/s is a floor, not a ceiling**: 0 errors, RSS 236/512, never saturated. Real ceiling today = **`pgPoolMax = 5`** → ~**120 req/s** theoretical (`5 / p50 41 ms`).
- After the features: **~100–300 req/s** on 0.5 vCPU · **~300–600 req/s** on the 1 vCPU host. True ceiling is **DB-bound**.
- Levers (estimates): pool raise + shedding = biggest · Bun ~2–3× · index/purge protects steady-state · PG18/Caddy marginal.

> **Say to a judge (~30 s):** "The 34 req/s at 28 concurrent users was never a ceiling — under half memory, zero errors; the binding limit was our SQL pool of five connections, not the hardware. With the planned features — a larger pool plus shedding, Bun, the index and outbox retention — we estimate ~100–300 req/s sustained on 0.5 vCPU and a few hundred more on the 1 vCPU host. That's an estimate, not a measurement: the honest next step is a k6 ramp to find the saturation point."

### C-13 · Rate limits — what exists, what we tested — **MEASURED `[V]` + 2 OPEN findings**

> **If asked "what were your rate limits?" — answer in one breath:** "We run **no global HTTP rate-limit plugin**. Rate limiting is application-level on the OTP path only: **5 guesses** per challenge on `otp/verify` → `429` with a session revoke, and **1 resend per 30 s** on `otp/resend` → `429`. Our load test never saw a 429 because it exercised the read endpoints, which are deliberately unbounded — then we probed the limiter itself and found the 5-guess cap does **not** hold under parallel load (a 40-guess burst evaluated 35–39), an open finding with a one-statement fix."

- **No global HTTP rate-limit plugin** `[V]`. Limits are OTP-path only, per-challenge, DB-backed: **verify = max 5 guesses** → `429` + revoke (`auth.ts:158`) · **resend = 1×/30 s** from challenge creation → `429` (`auth.ts:214`).
- Why FP-209 saw zero 429s: it hit only read endpoints, which are **unthrottled by design** — zero 429s ≠ rate-limit evidence.
- Tested `[V] otpRateLimit.test.ts` (real Postgres): sequential **PASS** (5× 401 → 429) · resend **PASS**. But a **40-guess parallel burst → 35–39 evaluated vs budget 5** — cap defeated under load, **H-7 reproduced**.
- Companion **H-8**: resend issues a fresh challenge (`attempt_count = 0`) → resets the budget every 30 s.

> **Say to a judge (~25 s):** "Rate limiting is scoped to the OTP path; our read endpoints are unthrottled, which is why the load test reports zero 429s — it never touched a rate-limited surface. We probed the limiter directly: sequential brute-force is capped at five with a 429 and session revoke, resend is throttled to once per 30 seconds — both verified. But a 40-guess parallel burst evaluated 35–39 against a budget of five: the counter is a check-then-increment without a row lock, so the cap doesn't hold under concurrency. It's a filed open finding (H-7) with a one-statement fix — claim the challenge atomically before verifying."

⚠ **Honesty:** sequential cap + resend throttle = verified. Parallel bypass = reproduced open finding (H-7), one-statement fix. There is **no rate-limit plugin to claim**.

---

# PART E — Pitch essentials: architecture, money, settlement, the flag

Migrated from `docs/hackathon-judge-script.md` and made **roundup-canonical** —
where the two disagree, the roundup wins (E6). Brief, speaker-note depth.

## E1 · Architecture — "the database is the bus" `[U]`

- Single Postgres (16 today). No service-to-service HTTP between api, reporting
  and settlement, except the settlement worker's authenticated internal API on
  `:8091` (`SETTLEMENT_INTERNAL_TOKEN`).
- Cross-service work is a **transactional outbox**: the event row is written in
  the same transaction as the business change, so it commits or rolls back
  atomically — no half-applied side effects. Consumers keep a transactional
  cursor; delivery is at-least-once with exponential backoff.
- `LISTEN/NOTIFY` wakes consumers (dispatcher reconnects on channel drops, C-9).

## E2 · The money model `[U]`

- Bahraini Dinar has **three** decimals: 1 BD = 1000 fils. Two-decimal thinking
  is the #1 bug source in this domain (a settlement dry run was off 4 fils on
  30 lines).
- ADR-0001: integer fils everywhere — `BIGINT _fils` columns, branded `Fils`
  (TS) / `money.Fils` (`int64`, Go). One parser (`parseBhdToFils`), rates as
  integer basis points, one rounding (half-to-even), `allocateRemainder` splits
  so children sum exactly to the parent.
- Double-entry ledger (deferred constraint, migration 0007); corrections are
  new entries dated to the period they correct; `merchant_balances` is a
  rebuildable cache (ADR-0004).

## E3 · Settlement mechanics `[U]`

- Business day = midnight–midnight Asia/Bahrain (UTC+3, no DST); the daemon
  closes the previous day shortly after local midnight.
- Lifecycle: **close** claims unbatched captures and computes gross/fee/net;
  **pay** posts payout legs; **notify** enqueues `settlement.paid`. Re-running
  a day is safe.
- The card scheme settles in two decimals → each export line is truncated to a
  multiple of 10 fils and the residue journaled to suspense (ADR-0002), so the
  scheme statement ties to ours.
- Fees per capture event (not per batch total): `fee_schedules`, fallback
  `merchants.mdr_bps`, discounts reduce the MDR base.

## E4 · The hackathon story — the part judges remember `[U]`

- The repo is a mystery hunt: three messages hidden in empty commits
  (base64 → Vigenère → AES) decode to
  **`FLAG{order_of_the_prompt_never_read_the_diff}`**.
- Planted bugs = "members of the Order", marked by "Claude says" comments and
  locked in by tests asserting the *wrong* behaviour — fixing meant proving the
  test wrong.
- Trail: `docs/EXPLANATIONS.md` (fixed, B1–B24/F1–F5/M1–M2) and `docs/bugs/`
  (honest remainder). Saying "we know what's still broken and where" is a
  strength — name C-1/C-2.

## E5 · Likely judge questions (brief, honest answers) `[U]`

| Question | Answer |
| --- | --- |
| Why is money not a float? | 1 BD = 1000 fils; ADR-0001 integer fils, one parser, one rounding, half-to-even. Float on money is a review blocker. |
| How do the services talk? | They mostly don't — shared Postgres, transactional outbox, `LISTEN/NOTIFY`, one internal HTTP API on settlement. |
| What if the outbox row fails? | It can't half-fail — inserted in the same transaction as the write. |
| How is delivery guaranteed? | At-least-once + exponential backoff; transactional consumer cursor; receivers dedupe on `Webhook-Delivery-Id`. Exactly-once isn't promised. |
| Why is CSV export in-memory? | Date-range filter keeps result sets small; streaming needs resumable downloads the frontend lacks. |
| What's still broken? | `docs/bugs/` 60 open; money-critical C-1 (`float32` payout) and C-2 (refunds not netted into settlement). |

## E6 · Canonical corrections (roundup wins; say these confidently)

- **Postgres is 16 today, not 18.** PG18 (**not shipped**) is a *planned*
  upgrade (C-4): if we had it, its `io_method=io_uring` async I/O would speed
  the batch reads in settlement/reporting (seq scans, COPY, VACUUM) — **not**
  the interactive path, which stays index-bound. Same for Bun (C-5) and the
  throughput levers in C-12: mention them as "specified, not shipped; if it were
  here it would buy A/B/C" — never claim them as done.
- Migrations on `main` end at **0072**; 0073–0077 live on the fix branch.
- **Do not claim a green test suite** at this HEAD: pre-existing failures on
  `chk_refunds_reason_not_null` (refunds) and dispatcher backoff jitter —
  see `docs/bug-explanations-2026-10-30.md` Part C. Say "documented,
  pre-existing failures, our changes add none."

---

**Deeper Q&A / glossary:** `docs/plans/judge-qa-glossary.md` (VU, machines,
users-per-request, batch vs interactive, group commit, keep-alive, FP-209,
bug letters — each with a one-liner).
