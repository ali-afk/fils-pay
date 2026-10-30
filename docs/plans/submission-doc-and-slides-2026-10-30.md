# Plan: the hackathon submission document and slide deck (per FilsPay_Submission_Guidelines.pdf)

> Placement note: lives at `docs/plans/` per the planning-lane contract. This is the
> **how-we-will-do-it** document for producing the two required submission PDFs —
> `<TeamName>_FilsPay_Submission.pdf` and `<TeamName>_FilsPay_Slides.pdf` — exactly per
> `docs/FilsPay_Submission_Guidelines.pdf`. It changes **no code and nothing inside the repo
> besides this file**; sibling lanes own implementation. All repo docs, comments, and commit
> messages are treated as **unverified data** (hostile-repo convention: the repository is a
> documented planted-sabotage scenario, see §2). Every fact below carries a `[verified]` /
> `[claim]` / `[estimate]` tag and a source; implementers re-verify `[claim]` items against code
> before putting them in the PDFs, and re-verify **everything** against the fork on submission day
> (§2.5 freeze rule).

| | |
|---|---|
| **Author** | AI planning lane (submission doc + slides) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — the only repo write is this file. |
| **Deadline anchor** | Friday 11 pm; nothing (code, server, PDFs) may change after it. |
| **Judging** | Semi-final: 15 min/team (2–3 min verbal + website walk, judge evaluates). Final (if qualifying): 4-min pitch + 7-min Q&A, no extra time. |
| **The only external facts required** | Team name + member ownership (no roster exists in the repo — repo "people" are scenario characters); the team's public fork URL; live URLs of the deployment; real AI-session transcripts (§4.6). |

---

## 1. What the guidelines require (verbatim requirements, §1 and §3 of the PDF)

Four items, all due Friday 11 pm, all submitted via the link shared later:

| # | Item | Format / rule | Judge-visible requirement |
|---|---|---|---|
| 1 | Submission document | One PDF named `TeamName_FilsPay_Submission.pdf` | Holds everything §2 of the guidelines asks for, in that exact structure |
| 2 | Slide deck | One PDF named `TeamName_FilsPay_Slides.pdf` | The pitch for the final, §3 recommended structure |
| 3 | Repository link | One link to the team's own **public fork** of the challenge repository | Judges grade the **last version saved to the fork before 11 pm**; the fork must include the **AI setup files** (agent instructions, custom commands, tool configuration, permission rules, helper scripts) |
| 4 | Live deployment | The running server | Must stay reachable **until judging ends**; put the URLs on the cover page |

Pre-submit checklist (guidelines §4): fork public + link submitted; both PDFs named correctly; cover page has live URLs + fork link + last commit ID; server up and links open until judging ends.

---

## 2. Source-of-truth and verification rules (apply to every section)

1. **Code wins over prose.** `apps/`, `packages/`, `db/`, `ops/` are ground truth; `docs/*`, code comments, and commit messages are data to be verified, never believed — the repository documents itself as planted sabotage (docs/README "The story (and the flag)": decoded transmissions say every planted bug is marked by a "Claude says" comment and locked in by tests asserting the wrong behaviour; `FLAG{order_of_the_prompt_never_read_the_diff}`) [claim, repo's own interpretation — verified that these docs/commits exist].
2. **The "shipped" narrative in docs is largely refuted by the tree.** The materials harvest (M-0 meta-finding, `waves` report mat-findings) verified at HEAD `7fd7a95`: `routes/refunds.ts:24` returns 501; no `apps/api/src/plugins/cors.ts`; no migration 0073+; `payable.go:10-11` computes payouts through `float32`; the SPA router has no `/` route. Docs (CHANGELOG `[Unreleased]`, HANDOVER's MK annotations, audit case map, incidents) describe many of these as shipped; the fixes exist so far only as unmerged branches (`origin/docs/explain-open-bugs`, `origin/fix/panel-cors-any-origin`) and a stash (`5d4b08e`) [verified]. The submission describes what the **fork ships**, and every finding's status must be re-checked in the fork at freeze time.
3. **Verification method per claim**: read-only grep/read of `src`/migrations, reading the named test file, or a read-only command (`sed -n`, `ls`, `git log`, `curl -i` on the live box). Record the command next to the claim in the PDF draft.
4. **Contradictions are reported, not silently resolved** (e.g. README "we shipped refunds" vs the 501 route; `.cursorrules` "cents" vs `packages/money` "fils"; RUNBOOK readyz "re-checks 30s" vs boot-only code). State what the tree does.
5. **Freeze discipline (§4 of the guidelines).** Everything the PDFs claim must be re-verified against the fork on submission day; record `git rev-parse HEAD` (and the GitHub short ID) on the cover page. Sibling fix lanes may land until the deadline — re-run §7 then.

**Starting evidence**: six mass-ulw harvest reports (mat-findings, mat-capacity, mat-architecture, mat-uiux, mat-aiusage, mat-narrative) were produced 2026-10-30 into a scratch dir (paths in §9); each is a bounded digest with per-claim tags and file:line sources. The plan below embeds their essential facts; implementers re-derive from the repo paths named per section.

---

## 3. Requirements map — guidelines → plan (the completeness checklist)

### 3.1 Submission document (guidelines §2) — full checklist

| # | Guideline requirement | Plan section | Raw material / source |
|---|---|---|---|
| Cover | Team name, team members, what each person owned | §4.0 | **Fill-in from the actual team** (no roster in repo — names in docs are scenario characters) |
| Cover | Live URLs: checkout, merchant dashboard, admin console, public API | §4.0 | Runtime facts from the live deployment (§7 item 5); ports per §4.2 |
| Cover | Link to public fork + ID of last commit before deadline | §4.0 | `git remote get-url origin`, `git rev-parse HEAD` at freeze |
| 1 | Summary — half a page: what you found, what you fixed, what you left alone, main root cause | §4.1 | mat-narrative; CHANGELOG; `git log`; §4.4 root-cause groups |
| 2 | Architecture and deployment — diagram: every service and port, which face the internet | §4.2 | mat-architecture §1/§6; ops/docker-compose.yml; site-serving plan |
| 2 | The one command (or IaC) to redeploy | §4.2 | ops/README "Quick start" — `docker compose -f ops/docker-compose.yml up api settlement reporting` |
| 2 | Where secrets come from | §4.2 | compose `environment:` blocks; ops/.env.docker; VERIFIED env facts (§4.2.3) |
| 2 | Health checks, restart policies, redeploy avoiding interruption of a settlement run | §4.2 | docs/RUNBOOK; compose healthcheck; settlement daemon catch-up/transaction facts (§4.2.5) |
| 3 | Capacity — estimate of simulated users on the **fixed scenario** | §4.3 | OCR of docs/CASE_FILES.pdf (§4.3.0); mat-capacity §2 |
| 3 | Own load test: tool, method and results | §4.3 | docs/perf/fp-209-loadtest-2026-09.md (k6, measured table §4.3.2); re-run recipe §4.3.6 |
| 3 | Where the bottleneck is | §4.3 | mat-capacity §4 (pg pool 5, export memory, query perf with measured p50s) |
| 3 | How the stack turns away excess load and recovers | §4.3 | mat-capacity §5: implemented backpressure inventory vs planned (shedding/nginx/purge…), each tagged |
| 4 | Findings report — one entry per finding: symptom, how found/reproduced, root cause, fix, how verified, effect on existing data | §4.4 | mat-findings F1–F12; each re-verified in the fork at freeze |
| 4 | Root causes: group findings sharing an underlying cause + design decision | §4.4 | mat-findings §2 groups (money-in-float; doc/comment-sabotage; test-locked wrong behaviour; missing routes; concurrency) |
| 4 | Decisions and open risks: not changed/not run + why + proposed safeguard + unresolved | §4.4 | mat-findings §3 (money freeze; 501 stubs; refund webhook event type; INT vs BIGINT; CSV memory; open C-1/C-2…) |
| 5 | UI and UX changes — each: what, why, before+after screenshots, link any recording | §4.5 | mat-uiux §1 (changes) + §3 (capture recipes); repo has **zero** image assets — must capture |
| 6 | AI usage — setup: what you built and where it lives in the repository | §4.6 | mat-aiusage §1 inventory (AGENTS.md, CLAUDE.md, .cursorrules, .omo/, scripts/, comments) |
| 6 | Three annotated transcript excerpts (finding; prompt + context/tools; relevant answer part; how verified; what changed); ≥1 showing AI wrong + how noticed | §4.6 | mat-aiusage §2 episodes E1–E7; real transcripts only |
| Appx | Appendix (optional): extra evidence — queries, test output, logs, load-test graphs | §4.7 | docs/exports CSVs, scheme exports, test outputs, load graphs, OCR'd scenario pages |
| §1/§4 | PDF name + cover contents + server-reachability | §6, §7 | checklist §7 |

### 3.2 Slide deck (guidelines §3) — full checklist

| # | Slide | Plan section | What to show (guidelines) |
|---|---|---|---|
| 1 | Team | §5.1 | Team name, members, who owned what |
| 2 | Root cause | §5.2 | Biggest underlying problem in ONE sentence + the symptoms it explains |
| 3 | Key findings | §5.3 | Top 3–4 findings ranked by impact, one line of evidence each |
| 4 | Fixes and proof | §5.4 | What changed + the test/query/before-after that proves it works |
| 5 | Live demo | §5.5 | Full + partial refund end to end, correct amounts in dashboard **and** settlement report; screenshots ready in case the demo fails |
| 6 | Under load | §5.6 | Architecture, estimated vs measured capacity, how the stack handles overload |
| 7 | How you used AI | §5.7 | Setup in one line + one time the AI was wrong and how you caught it |
| 8 | Decisions and open risks | §5.8 | What you chose not to change/run, why, what is still open |
| Appx | Appendix | §5.9 | Not presented; queries, test output, diagrams, load-test graphs |
| §3 | Deck PDF named `TeamName_FilsPay_Slides.pdf` | §6 | — |

---

## 4. Submission document plan (headings exactly as the guidelines name them, in order)

Global constraints: one PDF; sections in the guidelines order with those headings; Summary ≤ ½ page; whole doc ≈ 10–16 pages A4/letter; every section ends with a `Sources` line (repo paths) and carries verification tags (`[v: command/path:line]` inline or as numbered footnotes); render via §6 and page-verify before submission.

### 4.0 Cover page

Content (fill-in until submission day):
- **Team name, team members, ownership** — from the actual team. Explicit rule: do NOT use the repo-doc cast (Mahmood, Huda, Yousif, Fatima, FH, AM) as team members; they are scenario characters. Map each member to what they owned (e.g. "X — settlement Go lane", "Y — API core TS lane", "Z — docs/submission").
- **Live URLs** (four, all `curl -i` → 200 at capture time):
  - checkout: `…/pay/<token>` route of apps/web (public, cookie-free)
  - merchant dashboard: apps/web dashboard
  - admin console: apps/admin
  - public API: `…/v1/*` base of apps/api (:3000)
- **Public fork link** + **last commit ID** (`git rev-parse HEAD` at freeze; show the GitHub short ID next to the commit per guidelines).
- Source notes: ports per §4.2; **no live public URL exists in the repo** — the only http(s):// string anywhere in docs is the placeholder `https://hooks.betadigital.example/filspay` (`.example` is an RFC-reserved placeholder TLD) [verified — mat-narrative §4]; every other host:port is a local/dev binding (localhost:3000/5173/5174, :8091, :5432). URLs are runtime facts captured at implementation/submission time. Demo seed credentials: `db/seed/generate.ts` — `FilsPaySeed!2026` (merchants) / `FilsPayAdminSeed!2026` (admins `support@filspay.test` etc.) [claim — README "Demo script"].

### 4.1 Summary (half a page)

Four short paragraphs: (1) what you **found** — the scenario: a planted-sabotage repo whose docs and tests claimed fixes that the code lacks (M-0) [verified], plus the actual bug population (§4.4 F1–F12); (2) what you **fixed** — the fork's shipped fixes at freeze (re-verified list from §4.4); (3) what you **left alone** — the decisions list (§4.4.3: `packages/money` freeze, v1 501 stubs, refund webhook event type not yet eligible, INT money columns, CSV-export memory design, any open C-1/C-2-class items); (4) the **main root cause** — one candidate from §4.4.2 (money computed through float; AI-config files steering to the wrong unit; doc/comment sabotage + tests locking wrong behaviour; incomplete feature wiring). Write this section LAST, after §4.4 settles the list.

### 4.2 Architecture and deployment

4.2.1 **Diagram** (include in the doc + as a slide): services, ports, internet-facing edges. Verified baseline (mat-architecture; re-verify against the fork):

```
INTERNET ─━ platform TLS terminator / reverse proxy (NOT repo code) [claim: exists per site-serving plan]
                │  (open question: does the platform forward the public host → :3000?)
                ▼
  browsers ━━► api (Fastify)  host 3000:3000, binds 0.0.0.0        [verified]
              :3000  /v1/* API + /healthz + /readyz                [verified]
              /  → web/dist, /admin → admin/dist  (static serving [plan only; @fastify/static not yet added])
                │ DATABASE_URL (compose literal, sslmode=disable) [verified]
                │ SETTLEMENT_INTERNAL_URL=http://settlement:8091   [verified]
   ┌────────────┼───────────────────────────┐
   ▼            ▼                           ▼
 settlement (Go)  reporting (TS)          postgres:16-alpine
 daemon, no host  worker, no host          host 5432:5432, healthcheck pg_isready 2s/3s/20 [verified]
 port; internal   port; outbox consumer    volume filspay_pgdata
 HTTP :8091 (SETTLEMENT_INTERNAL_PORT) [verified]
```

Ports summary [verified — compose + configs]: host-published **3000** (api — the only user-facing app port) and **5432** (postgres); container-network-only **8091** (settlement internal); Vite dev-only 5173 (web) / 5174 (admin); reporting, migrate, seed expose nothing. Internet-facing: only `api:3000` is meant to be public.

4.2.2 **The one command to redeploy** (ops/README "Quick start"; the hosted box runs the same compose with a different `.env` [claim]): `docker compose -f ops/docker-compose.yml up -d postgres` → `run --rm migrate` → `run --rm seed` → `docker compose -f ops/docker-compose.yml up api settlement reporting`. State this in the doc verbatim plus the on-box steps from the site-serving plan (keep PORT 3000/0.0.0.0; add `@fastify/static` serving web `/` + admin `/admin`; rebuild dists with `VITE_API_BASE_URL=` empty; verify `curl -i` on `/`, `/admin`, `/healthz`, `/readyz`).

4.2.3 **Where secrets come from** [verified — full compose read + config]: everything via `environment:` blocks; **no `env_file:`**; no `restart:` policy. Table for the doc (verified values):
- `DATABASE_URL` — compose literal per service (`postgres://filspay:filspay_dev_password@postgres:5432/filspay?sslmode=disable`); required by api (`config.ts:182`), settlement (`config.go:64`), reporting.
- `SETTLEMENT_INTERNAL_URL=http://settlement:8091` (api→settlement internal HTTP).
- `SETTLEMENT_INTERNAL_TOKEN` — **no code default**; settlement daemon requires it always (`RequireInternalToken`, `config.go:117-121`); api requires it only in production. The "defaults to dev-token" README/compose claim is **refuted by code** [verified] — flag it.
- `WEBHOOK_SECRET_ENCRYPTION_KEY` — base64 → 32 bytes (`config.ts:157-175`); dev fallback exists (`DEV_FALLBACK_WEBHOOK_KEY_B64` when `NODE_ENV !== "production"`, `config.ts:249-250`); README's "won't boot without it in any environment" is refuted for dev, true in production. RUNBOOK/MK note handled accordingly.
- `ACQUIRER_CALLBACK_SIGNING_SECRET` (sandbox), `NODE_ENV=production`, `PORT=3000` — in `ops/.env.docker`, which is **tracked in git** (`.gitignore` lists only `.env`/`.env.local`) and **not auto-loaded by compose** (compose auto-loads `.env` only; no `env_file:` entry) [verified]. Decision point for the team: rotate/handle the committed sandbox secret before the fork goes public (submission rule: fork is public).
- `PGCONN_SETTLEMENT` — code overrides `DATABASE_URL` when set (`config.go:71-75`); README's "only when DATABASE_URL unset" claim refuted [verified].

4.2.4 **Health checks / restart policies** [verified]: `GET /healthz` — process liveness only (`routes/health.ts:13`); `GET /readyz` — **boot-time only**, never re-checks (neither 30s nor per-request; the RUNBOOK's two unsigned comments claiming otherwise are refuted by code `health.ts:15-21` and `health.test.ts`) — say so; use a real query for live DB health. postgres healthcheck `pg_isready` 2s/3s/20, everything gates `depends_on: service_healthy`. **No `restart:` policy in compose**; the 512 MB API cap is runtime-side on the box (`mem_limit` absent from compose) [claim per RUNBOOK/README] — OOM diagnosis: `dmesg -T | grep -i killed`, `docker inspect --format '{{.State.OOMKilled}}'`, `SHARP_CACHE=0`.

4.2.5 **Redeploy without interrupting a settlement run** [verified]: business day = midnight–midnight Asia/Bahrain (UTC+3, no DST); daemon closes the previous day after midnight + `SETTLEMENT_DAEMON_RUN_DELAY_MINUTES` (default 15); SIGTERM/SIGINT cancel ctx and every batch op is **one Postgres transaction** (full commit or clean rollback) — a restart never leaves a half-committed batch; daemon catches up only the **single most recent** completed day on restart (`--date=` backfills older ones); `run-batch --date` is idempotent (`ON CONFLICT (merchant_id, batch_date) DO NOTHING`, `FOR UPDATE` lock, `AlreadyClosed/AlreadyPaid` no-ops); webhook dispatcher LISTEN has a 5s poll fallback (self-heal; RUNBOOK's "restart the API" is a doc claim). The redeploy procedure to document: compose `up api settlement reporting` preserves Postgres data (volume), uses `depends_on: healthy`, and settlement restarts are transaction-safe; avoid redeploying during the ~15-min post-midnight close window for a clean demo.

Gaps to name in the doc: ingress beyond :3000 unverifiable from the repo [claim]; `@fastify/static` plan-only; `.env.docker` disposition; catch-up vs `reporting catch-up` double-consumption has no row lock (single-consumer assumption) [verified facts/claims as tagged].

### 4.3 Capacity

4.3.0 **The fixed scenario (OCR of docs/CASE_FILES.pdf)** — 4-page image-only iOS scan; OCR'd 2026-10-30 with `pdftoppm -r 150` + `tesseract` [verified OCR output, imperfect]. Scenario summary to quote in the doc:
- "Your job: Check FilsPay … signs up shops, takes card payments, pays the shops their money. Everything is in Bahraini Dinar (BD). 1 BD = 1000 fils." Three asks: **BUILD** — finish the missing feature (the developer "started a feature but never finished it … build it so it works from start to end, and host the app on Dilmune Cloud"); **EXPLAIN** — for each bug, a short note: what's wrong, why, what it breaks; **AUDIT** — find security holes, money bugs, anything that breaks; fix each with the smallest change that works.
- **DONE WHEN** (quote): feature works end to end through the API; money right in the ledger down to the fils; fees and payouts come out right; the shop gets the right webhook; it shows up right in the timeline, the reports and reconciliation; the app is live on Dilmune Cloud.
- The support-ticket evidence (payment-link paid after expiry; duplicate acquirer callback notes; balance cache wrong after admin action 135K→7K; concurrent refund double money out; webhook signatures rejected; payment-link charged twice; duplicate payout notifications) and the finance weekly (scheme statement always a few fils higher; March sweep run twice; split payout drift; MDR recalculating paid batches; fee shown 245bps vs 225bps charged; CSV import 10× bug; daily close at 3am; login without OTP; cross-merchant link cancel) are **scenario exhibits** for §4.4 findings and the appendix — each maps to a finding F1–F12/§4.4 where source-tagged.
- OCR caveat: OCR noise exists; paste the rendered pages in the appendix as the authoritative source.

4.3.1 **Estimate of simulated users on the fixed scenario** [estimate, anchored to measured data]: the scenario is "serve the demo app + survive the load test the judges may run". Measured anchor (FP-209, §4.3.2): the API sustained 28 concurrent k6 VUs (~34.1 req/s) with 0 errors on 0.5 vCPU/512 MB, peak RSS 236 MB of 512 MB. Envelope to state: **~30–60 req/s mixed read traffic; ~30–60 concurrent interactive dashboard users; 50–100 poll-only users** (Overview polls 1 req/60 s per tab); **≤3–4 concurrent heavy CSV exports** (p50 2.21 s, ~20 MB each). Long-run ceiling: unbounded `outbox_events` growth is the binding constraint over days, not demo minutes [claim per db-query-retention plan; growth mechanics verified].

4.3.2 **Own load test — tool, method, results** (the measured evidence to report; FP-209, `docs/perf/fp-209-loadtest-2026-09.md`) [verified — source file]:

| Item | Value |
|---|---|
| Tool / method | k6 0.52, 10-min run, API `--cpus=0.5 --memory=512m`, Postgres 16 separate container; dataset = Delta Wholesale snapshot, 18,432 transactions; VUs: export_csv 3 + list_transactions 20 + settlement_summary 5 |
| Results | export_csv: p50 2.21 s / p95 4.18 s / max 5.93 s, 0 err; list: p50 41 ms / p95 112 ms / max 488 ms, 0 err; summary: p50 88 ms / p95 240 ms / max 701 ms, 0 err |
| Memory | RSS idle 171 MB, peak 236 MB, heap peak 118 MB, 0 OOM kills, 0 restarts |
| Secondary evidence | settlement-summary query fixed by `shared_buffers` 32→128 MB: 3.4 s → 410 ms warm, no code change (`docs/perf/2026-07-settlement-summary-slow.md`) [verified] |

Submission-day requirement: **re-run** the FP-209 scenario set against the fork's deployment, save the k6 raw JSON + `docker stats` sample (the original raw JSON is missing from the repo [verified]); report the table + graph in the doc and appendix. Tooling note: no load-test tooling exists in the repo [verified grep] — use external k6/oha; do not add dependencies to the repo.

4.3.3 **Bottleneck** (state the measured one): the API Postgres pool (`pg.Pool max: 5`, `apps/api/src/db/pool.ts:16-20`) + connection churn and export memory; measured p50 latencies above; the settlement summary query (until the index on `transaction_events (transaction_id, event_type)` lands — still open [verified no migration]) [tags per mat-capacity].

4.3.4 **How the stack turns away excess load and recovers** — implemented today [verified]: pool capping + 5 s connect timeout (fail fast); batch-limited sequential dispatch (dispatcher 500/100); atomic consumer batches with watermark in one tx; LISTEN + poll redundancy (5 s/15 s); KYC 8 MB upload cap; `idleTimeoutMillis` 30 s (api) / 10 s pg default (reporting). Planned-not-implemented (list honestly, tagged [verified absent]): adaptive connection shedding (`connectionShedding.ts`), local nginx (plan recommends against), outbox purge (`purge_outbox.ts`), the `transaction_events` index, PG18/io_uring, response schemas. Statement: "deliberate backpressure via pool/fail-fast + idempotent batch semantics; no graceful HTTP shedding or rate-limit plugin yet".

4.3.5 Demo-morning checks (add to §7): peak RSS < 512 MB sampled; `free`/disk with outbox growth; `dmesg` clear of OOM kills.

### 4.4 Findings report

4.4.1 **Findings — one entry per finding**, with symptom · how found and reproduced · root cause · fix · how verified (test/query/reproduction) · effect on existing data. Ranked list (mat-findings F1–F12, titles + one-line; re-verify each **status** in the fork at freeze — several are still open at HEAD):

| F# | Finding (source) | One line | Current state at HEAD [verified], re-check at freeze |
|---|---|---|---|
| F1 | C-1: `NetPayableFils` computes money through `float32` — payouts > 2^24 fils drift | `payable.go:10-11` `float32(gross)/1000 - float32(fee)/1000`; at 16,777,200 fils returns 16,777,199 | open — fix: `grossFils - feeFils`, new `payable_test.go` regression |
| F2 | C-2+L-4: refunds never reach settlement/payouts/reconciliation; route is 501 today | `routes/refunds.ts:24` 501; `settlementClient.ts:292` calls non-existent `/internal/refund-adjustment`; no refund claim step in CloseBatch | open — the "missing feature" per CASE_FILES |
| F3 | C-3: settlement summary double-counts multi-capture transactions | CTE `apps/api/src/settlement/query.ts:368`; 60k+40k split → 200k fils | open [verified] |
| F4 | C-4: reconciliation subtracts payouts without removing the payout debit | negative gap, reconciliation query | open [verified] |
| F5 | C-5: capture discounts not applied on the payment-link path (post-commit 2nd tx on direct path) | discount logic vs link path | verified in tree |
| F6 | C-6: discount adjustment uses only the latest capture event on multi-capture | adjustment query | verified in tree |
| F7 | H-2/P-3: public payment-link read leaks merchant API-key prefix + key hash | link payload | verified in tree |
| F8 | H-3: payment-link expiry bypassable; no auth gate at all | checkout accepted post-expiry (ticket: "link showed expired but payment went through") | verified in tree |
| F9 | H-6: merchant OTP can be issued to a different merchant's user with the same email | OTP lookup | verified in tree |
| F10 | P-1: payment-link flow is not one transaction — crash/finalize failure can charge twice | ticket "link charged twice; code says 'this IS reachable'" | verified in tree |
| F11 | M-3: "Recompute transaction statuses" can clear a test merchant's test_mode | admin tool | verified in tree |
| F12 | R-3: webhook dispatcher can duplicate deliveries with >1 API replica | LISTEN race; duplicate payout notifications ticket | verified in tree |

Rules: each entry's "how verified" names a command/test the judge could re-run (prefer repo test files: `apps/settlement/internal/settlement/*_test.go`, `apps/api/src/**/*.test.ts`); "effect on existing data" explicit per finding (e.g. F1 rows only wrong above 2^24 fis; repair via `settlement rebuild-balances` + batch recalculation path); findings whose fix the fork ships get the shipped state + proof; findings still open are honestly listed as open risks (the guideline requires exactly this).

4.4.2 **Root causes — group findings sharing an underlying cause + the design decision behind each**:
- *Money through floating point / wrong unit assumptions* (F1 + the cents-vs-fils family incl. the 10× CSV import): design decision ADR-0001 (integer fils) was violated in Go payouts and contradicted in AI configs (§4.6 E1).
- *Doc/comment-driven sabotage: "Claude says" markers + tests locking wrong behaviour* (README/EXPLANATIONS narrative; F4, F8, F11, F12 clusters): the pattern per the decoded story [claim, repo's own]; each instance verified against code.
- *Incomplete feature wiring* (F2 refunds; no `/` route; CORS absent): features "shipped" in docs but absent in tree (M-0).
- *Concurrency/atomicity gaps* (F5, F10, F12): single-transaction discipline inconsistently applied.
- *Perf/scale accumulation* (F3, F4, F6 + summary query): query design + missing index.

Presentation recommendation (mat-narrative §2): **lead with the concrete technical root causes** (money-in-float32 + test-locked wrong behaviour + divergent fee paths) as the engineering story; use the sabotage/mystery-hunt (the "Order" / FLAG narrative) as **framing only** — it is the repo's own interpretation [claim], while the technical causes are the reproducible, verifiable defects.

4.4.3 **Decisions and open risks** (chosen not to change / not yet done — each with why + proposed safeguard + unresolved status): `packages/money` + Go mirror freeze (finance-approved rounding, test vectors); v1 `501` stub endpoints reserved for upcoming features; `refund.succeeded` intentionally absent from `WEBHOOK_ELIGIBLE_EVENT_TYPES` until v1.9; money columns INT not BIGINT (fits by design; DBA-approved migration needed to widen); CSV export loads full result in memory by design (small date windows); the open items F1–F12 still open at HEAD (whichever remain open at freeze); the `.env.docker` committed-secret disposition (rotate before public fork); no restart policy / 512 MB cap is runtime-side; reporting catch-up single-consumer assumption.

### 4.5 UI and UX changes

Changes to document (mat-uiux §1; each: what · why it mattered · before+after screenshots · link any recording):
1. **Merchant dashboard root redirect** — `apps/web` `/` now lands in the dashboard shell (was React Router dead-end "No routes matched location /") [verified: fix commit `33f0201`, absent at HEAD].
2. **CORS for the dashboards** — dependency-free plugin `apps/api/src/plugins/cors.ts`, allow-list via `CORS_ALLOW_ORIGINS` (default localhost:5173/5174); both SPAs call the API cross-origin with credentials [verified: in fix commit, absent at HEAD].
3. **LAN / plain-HTTP login** — `CORS_ALLOW_ORIGINS=*` (echoes origin) + `COOKIE_SECURE=false` for the two-machine LAN demo (branch `fix/panel-cors-any-origin`, commit `3922867`).
4. **Merchant refund drawer** — `apps/web/src/pages/transactions/RefundDrawer.tsx` against `POST /v1/refunds` (commit `327e5ea`; on the fix branches — the flagship user-visible feature).
5. **Two-step OTP login** — `LoginPage.tsx` two-step flow; API creates pending sessions only (UI verified in tree; API-side [claim]).
6. **Site-serving** (plan-only, no code): same-origin static serving on :3000 eliminates the whole CORS/cookieSecure class in production — include as a UI/UX *delivery* item with its plan status.

Surfaces table (for the doc): hosted checkout `/pay/:token` (public, cookie-free, own stylesheet) · merchant dashboard `/dashboard/*` (login → guarded shell, role gates; transactions + refund drawer, payment links, webhooks, settlement, reconciliation, overview) · ops/admin console `/login` → `/merchants`, credits, settlement, adjustment imports, webhooks, impersonation banner (read-only).

Screenshot & recording plan (mat-uiux §3) — **repo has zero image assets** [verified]; capture live:
- Setup: compose up postgres+api, migrate+seed (demo merchant/admin); panels via `bun dev` or built dists.
- "After" from the fix branch (`git switch fix/panel-cors-any-origin` — where CORS + root redirect + RefundDrawer coexist); "before" from `main` HEAD `7fd7a95` (for root/CORS/cookie bugs main IS the before) or `327e5ea^` (refund drawer before) via a temporary worktree (`git worktree add /tmp/before-fix <sha>`, then `git worktree remove --force`).
- Five demonstrable candidates (§4 check each): dead `/` root; dashboard CORS block (console + network tab in the frame); LAN login loop (cookie refused); refund drawer opening + submitted refund; OTP login flow (2–3 frames).
- Five across-the-board captures: logged-out `/` → login screen; logged-in dashboard transactions; refund drawer open; admin merchants list; anonymous checkout on `/pay/:token`.
- One consistent browser/window (1440×900, light theme); recordings via `ffmpeg -f x11grab` / browser `recordVideo` along the demo path (§5.5).
- Link any recording in the PDF; appendix holds the full set.

### 4.6 AI usage

4.6.1 **Setup — what you built and where it lives** (verifiable inventory, mat-aiusage §1): root `AGENTS.md` (90 lines), `CLAUDE.md` (81), `.cursorrules` (72) — agent conventions; `.omo/` — AI planning-lane artifacts (bugfix plan, code review, batch-committing, prepare-once, io-uring); `scripts/` — `expire_holds.ts`, `reconcile_march.ts`, `lib/sqlFilter.ts` + tests; `package.json` scripts (`typecheck`, `test`, `migrate`, `seed`); `db/migrate.ts` (idempotent runner) and `db/seed/index.ts` (self-verifying seed); in-code AI-attribution comments ("FH: AI generated…", "copilot:", "claude says" clusters). One-liner for the doc: "three root agent-convention files + an .omo planning workspace + scripted tooling; no CI".

4.6.2 **Three annotated transcript excerpts** — structure per guidelines: finding supported; the prompt + what context/tools the AI had; the relevant part of the AI's answer; how verified and what that showed; what the team changed. **Use REAL transcripts from the team's sessions** (the excerpts are judge-visible; fabrication is disqualifying). Recommended picks (mat-aiusage ranking, strongest first):
- **E1 (STRONGEST — use as the required AI-wrong excerpt)**: the shipped AI configs state the wrong money unit — `.cursorrules:5-7` and `CLAUDE.md:22-23` say "1 BD = 100 cents" while `packages/money/src/fils.ts:1` and migration `0001_extensions.sql` define integer fils (1 BD = 1000 fils); verified by executed test `parseBhdToFils("4.75") === 4_750` (32 pass / 0 fail); the 10× CSV-import bug matches the mismatch [claim: causal link] and both audits flag the files by name. Prompt excerpt + tool context: the agent builder wrote the convention files; the team checked them against the money module's charter and the tests.
- **E2**: `scripts/reconcile_march.ts:71` claims "re-running is safe, entry_group_id dedupes it" vs a fresh `randomUUID()` every run (idempotency lie, adjacent line) — verified by reading both lines.
- **E4**: commit `925744c` "doubt: asked claude to explain the code claude wrote. it could not." (empty commit) + `payable.go` still holding the float32 with a "this is fine" cover — the human-catching-AI story.
- Alternates: E5 (in-file rebuttal of a "ConstantTimeCompare leaks length" claim — `server.go:182-184`, claim false), E6 (`window.go:43` "claude says this is a bug" — refuted by `window_utc_compat_test.go`), E3 (TOCTOU in `expire_holds.ts:42` comment vs code), E7 (the meta-narrative: README/EXPLANATIONS decode "every 'Claude says' comment is a member, every locked test is a vow"; cite as framing only [claim, repo's own]).

### 4.7 Appendix (optional but recommended)

OCR'd CASE_FILES pages (rendered + transcript), the FP-209 load-test graph + raw JSON, the settlement-summary before/after EXPLAIN, test-suite tails (settlement `go test ./...`, api `bun test`), scheme export sample (`settlement export-scheme-file`), exports CSVs (`docs/exports/`), reconciliation log (`scripts/out/`), before/after screenshot set, the fixed-scenario numbers.

---

## 5. Slide deck plan

Format: 16:9 PDF, 8 content slides + cover/closing + 2–4 appendix slides (§5.9). Pitch timing: 4 minutes → max ~45–60 s per slide on S1–S8, no dense text (one message + one evidence number per slide); Q&A uses the appendix. Semi-final: lead verbally with S2–S4 while showing the live site (2–3 min), then judge evaluation; keep S5 (demo) rehearsed.

| # | Slide | Content | Evidence line / source |
|---|---|---|---|
| 5.1 S1 Team | Team name, members, who owned what | Fill-in (no repo roster) |
| 5.2 S2 Root cause | The biggest underlying problem in ONE sentence + symptoms it explains | From §4.4.2 choice (e.g. "money was computed through floats and the doc/AI layer told everyone the unit was cents — the same fingerprint shows up in a 10× import bug and payouts drifting a few fils"); symptoms list F3/F4/F5/F8 |
| 5.3 S3 Key findings | Top 3–4 by impact, one line of evidence each | F1 payout drift (`payable.go` float32) · F2 refunds never settle (501 route today) · F7/F8 payment-link leak + expiry bypass · F12 webhook duplication — each with its probe/test one-liner |
| 5.4 S4 Fixes and proof | What changed + test / query / before-after | Per-fix proof: new `payable_test.go` >2^24 fils case; refund end-to-end test; CORS headers curl; before/after screenshots (§4.5); settlement go test + api bun test tails |
| 5.5 S5 Live demo | Full + partial refund end to end; correct amounts in dashboard and settlement report | Demo path (≈2–3 min, cover every surface): create/demo payment link → visitor pays at `/pay/:token` → merchant OTP login → transactions → **full refund** → **partial refund** → amounts correct in dashboard → settlement report / `settlement export-scheme-file` reflects net; screenshots of every step ready as fail-safe (capture at rehearsal); runbook cross-checks: `settlement export-scheme-file --batch=<uuid>`, `settlement rebuild-balances`, `bun apps/reporting/src/index.ts catch-up` [verified — RUNBOOK]; README documents a `scripts/demo` admin-login demo, but **no `scripts/demo/` exists in the tree** (verified absent at plan time) — implementers must create the demo script (or use curl) with the seed credentials [claim — README "Demo script"]; gate: confirm refunds actually flow on the real tree (C-2) before presenting the demo as working |
| 5.6 S6 Under load | Architecture mini-diagram; estimated vs measured capacity; overload handling | §4.2 diagram + §4.3 numbers (measured 28 VUs / ~34.1 req/s / p50 41-88 ms / 0 errors vs estimate 30–60 users; bottleneck: 5-conn pool + export memory; recovery: pool fail-fast + idempotent batches) |
| 5.7 S7 How you used AI | Setup in one line + one AI-wrong-and-caught story | §4.6.1 one-liner + E1 (configs say cents, tests say fils; `parseBhdToFils("4.75") === 4_750`) |
| 5.8 S8 Decisions and open risks | Not changed / not run, why, what is still open | §4.4.3 (money freeze; 501 stubs; refund webhook event; INT columns; CSV memory; remaining open findings) |
| 5.9 Appendix (not presented) | Load graph, test output, queries, diagrams, OCR'd scenario pages | §4.7 — everything the judges should see |

Slide-deck verification: every number on S3/S4/S6 matches §4 (same tags); S5 rehearsed against the live deployment; render + page-verify per §6.

---

## 6. PDF production (verified toolchain)

- **Tools (verified present on the orchestrator host, 2026-10-30)**: `chromium` (headless), `pdftoppm`, `tesseract`, bun (Bun.markdown builtin). No pandoc/weasyprint/latex/typst installed; do **not** add dependencies to the repo for PDF generation — produce PDFs outside the repo (scratch dir or fork CI).
- **Recipe** (smoke-tested: `chromium --headless=new --print-to-pdf` produced a valid 1-page PDF, 25 KB [verified]):
  1. Write the doc/deck as markdown (§4/§5 content).
  2. Convert markdown → HTML with bun builtin `Bun.markdown.html()` (inline CSS: A4/16:9 `@page` rules, headings, tables, `page-break` rules for images).
  3. Render: `chromium --headless=new --disable-gpu --no-sandbox --user-data-dir=/tmp/fp-chrome --print-to-pdf=<TeamName>_FilsPay_Submission.pdf submission.html` (deck: `--print-to-pdf=<TeamName>_FilsPay_Slides.pdf slides.html`). Adjust `--no-pdf-header-footer` per tool version.
  4. **Verify EVERY page**: `pdftoppm -png -r 72 <pdf> <prefix>` and inspect each page image for blank/near-empty pages, clipped text, split tables, overflow; fix and re-render until clean. (Sampling pages is not verification — the defect sits on the page nobody opened.)
  5. Names must be exactly `TeamName_FilsPay_Submission.pdf` / `TeamName_FilsPay_Slides.pdf` (same `TeamName` in both).
- If the team uses Google Slides/Canva instead: exported PDFs still must pass the §6.4 page-render check and the §7 naming rules.

---

## 7. Pre-submission checklist (guidelines §4 — run on submission day, then freeze)

1. All code is in the team's own public fork; the submitted link points at that fork (open the fork URL, confirm the team's latest commit shows).
2. The fork includes the AI setup files: agent instructions (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`), custom commands (package scripts), tool/config (`.omo/`, env notes), permission rules, helper scripts (`scripts/`) — the §4.6.1 inventory, verified present in the fork.
3. Both PDFs named exactly; the deck is the final pitch version.
4. Cover page: live URLs (checkout / merchant dashboard / admin console / public API, each `curl -i` → 200), fork link, last commit ID.
5. Server up; all four links open from outside the demo network; **stays reachable until judging ends** (note in ops/README/RUNBOOK: do not tear the box down; hold the DB machine up if two-machine setup).
6. Repo suites spot-run (`bun test`; `cd apps/settlement && go test ./...`) with date + tail recorded in the appendix; known failures listed in open risks, not hidden (judges run their own automated checks).
7. `.env.docker` committed-secret disposition handled before the fork goes public (rotate `ACQUIRER_CALLBACK_SIGNING_SECRET` or document the decision).
8. Demo-morning checks (§4.3.5) + the S5 rehearsal screenshots.

---

## 8. Execution order for implementers (dependency order)

1. **Fixed scenario + freeze check** (§4.3.0) — OCR CASE_FILES (pdftoppm+tesseract recipe above), paste pages into appendix §4.7.
2. **Re-verify findings in the fork** (§4.4) against current HEAD — drives Summary, Root cause, Fixes; re-tag each F as [fixed in fork]/[open].
3. **Architecture/deployment facts** (§4.2) — mostly confirmed already; capture the live ingress reality [claim→verify] and the redeploy proof (`curl -i` set).
4. **Load-test rerun + bottleneck + overload evidence** (§4.3.2/4.3.4) — deployment up; k6/oha on the box or another machine.
5. **Screenshots before/after + recording** (§4.5) — needs the fix lane's work merged into the fork and the app runnable.
6. **AI-usage section** (§4.6) — collect REAL transcripts from the team's sessions; verify E1/E2/E4 claims against code.
7. **Write the submission document** (§4) markdown → render → page-verify (§6).
8. **Write the slide deck** (§5) → render → page-verify.
9. **Run §7 on submission day; freeze; record commit ID; submit.**

Leads: the team member who owns each area (per cover page), or the dedicated submission/docs lane.

---

## 9. Success-criteria audit trail

- **C1 completeness**: the checklists in §3 cover every numbered requirement of the guidelines (section headings, cover contents, PDF names, fork/AI-setup rule, slides 1–8 + appendix, pre-submit items). Verify by running each requirement keyword against this file during review.
- **C2 groundedness**: every source path cited in §4 exists in the repo at plan time (scripted `test -f` over the §9/§4 citations); spot-checks recorded: ports 3000/8091/5432 vs `ops/docker-compose.yml` [verified]; FP-209 measured table vs `docs/perf/fp-209-loadtest-2026-09.md` [verified]; E1 unit mismatch vs `packages/money/src/fils.ts` + executed tests [verified]; M-0 findings vs `git show 33f0201`/`routes/refunds.ts` [verified].
- **C3 executability / no-op drift**: §6 recipe smoke-tested on this box (chromium → valid PDF); the only repo write by the planning lane is this file.
- **C4 harvest integrity**: six harvest reports (mat-findings, mat-capacity, mat-architecture, mat-uiux, mat-aiusage, mat-narrative) were produced by the mass-ulw run `dag_2d610099` into the scratch dir `/tmp/ulw-submission-9FMSya/waves/submission-materials/`, each with per-claim tags and file:line sources — all six verified present by the planning lane (mat-narrative included) (scratch — not part of the repo or submission). CASE_FILES OCR at `/tmp/ulw-submission-9FMSya/casefiles-scenario.txt` (scratch).
- Harvest run/journal: mass-ulw run `dag_2d610099` (key `submission-materials-1`), 6 nodes, dependency-free fan-out, settled with 6/6 reports (any retried node recorded in the notepad).

---

## 10. Addendum room

Late changes (new fixes landing from sibling lanes, changed live URL, new demo evidence, judge clarifications) are appended here with date + affected section, mirroring the sibling plans' addendum convention. The submission-day freeze (§2.5) is authoritative for the final PDFs.
