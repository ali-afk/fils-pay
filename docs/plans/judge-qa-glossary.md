# FilsPay — Judge Q&A, quick answers (glossary companion)

**Date:** 2026-10-31 · **Companion to:** `docs/plans/judge-speaker-card.md` and
`docs/plans/judges-roundup-2026-10-31.md`. Short judge-ready answers to the
questions that come up — definitions first, the one-liner you can actually say
under the question.

---

## What is a VU?

A **virtual user**: a simulated user in load testing that runs a scripted
scenario in a loop. k6 runs VUs as concurrent goroutines inside one process.
"28 VUs" = 28 concurrent simulated users hitting the API.

> "A VU is one simulated logged-in user loop — 28 VUs ran side by side for the
> ten-minute run."

## How many k6 machines did we use?

**One.** A single k6 0.52 instance ran all 28 VUs in-process. No distributed
load (k6-operator/cloud) — that's only needed for cross-machine scaling.
Caveat: the doc implies one host but never logs a machine count; the raw k6
JSON is missing from the repo.

> "One k6 instance — VUs are threads in a single process, so one machine was
> enough for 28 users."

## How many users per request?

Framing fix: it's the inverse — one VU issues *many* requests. FP-209: 28 VUs →
**20,471 requests** over 600 s → **~731 requests per VU**, aggregate **~34
req/s**, ~**1.2 req/s per VU**. One request is always handled by exactly one
VU; concurrency comes from VUs running in parallel.

> "28 users drove ~731 requests each — 34 req/s aggregate — because one user
> keeps polling its page, not one request per user."

## Batch path vs interactive path

Two workload classes on the one Postgres:

- **Interactive** — online, latency-sensitive: dashboard lists, settlement
  summary page, checkout. Index-driven small reads, p50 tens–hundreds of ms.
- **Batch** — offline, bulk, latency-tolerant: Go settlement's nightly close,
  fees, **COPY** scheme exports, reconciliation, VACUUM. Sequential scans over
  big ranges (a 400k-row scan, 118k-row hash join); minutes are fine.

PG18's `io_uring` (planned) targets the **batch** side only; interactive stays
on indexes + `shared_buffers`. The levers don't overlap.

> "Interactive is what a user waits on — keep it index-fast. Batch is what runs
> at midnight — scans and COPY, where async I/O pays."

## Why not group commit?

Rejected (the *completion batching* item). Four reasons:

1. **HTTP is synchronous** — a `200` must mean durable; batching either delays
   responses or breaks the durability guarantee.
2. **Widens/lengthens row locks** — one slow member holds everyone open; it's the
   exact contention the settlement code avoids.
3. **Re-implements the outbox** — async cross-service work already runs through
   the transactional outbox + dispatcher; a second async layer adds nothing.
4. **Nothing to unlock** — ceiling is `pgPoolMax = 5` on 0.5 vCPU, not commit
   fsync cost; Postgres batches WAL flushes itself.

> "Low-value, high-complexity here: synchronous HTTP leaves no latency to hide,
> and the real bottleneck is the SQL pool, not commit cost."

## What is C-11 (keep-alive coherence)?

HTTP/1.1 reuses idled TCP sockets; both ends close them after their own *idle
timeout*. Node/Fastify defaults to ~**5 s**; Caddy's proxy defaults to
**minutes**. The proxy keeps socket alive, Node kills it, next request pays a
reconnect. Fix: align the timeouts (`keepAliveTimeout 60000` on Caddy /
`proxy_set_header Connection ""` + `proxy_http_version 1.1` on nginx).

> "We aligned the proxy and Fastify idle timeouts so a socket neither side is
> about to reuse gets reused — a mismatch fix, not a throughput lever."

## What is FP-209?

**FP = FilsPay, 209 = issue number** — the load-test work item in the same
tracker as FP-187 (March close) and FP-212 (refunds). `fp-209-loadtest-2026-09.md`
is its writeup; its numbers are the **no-regression gate** for every perf plan.

> "FP-209 is our load-test ticket — the 34 req/s baseline every later plan
> checks against."

## Bug ledger letters

Letter = category tag, number = ordinal within it (not a version).

| Letter | Category | Count |
|---|---|---|
| **C** | Critical money (move money wrong) | 6 |
| **H** | Security & auth | 13 |
| **P** | Payment links | 4 |
| **M** | Money-path | 12 |
| **R** | Reliability | 7 |
| **S** | Validation | 9 |
| **L** | Operational | 9 |
| **F** | Reporting | 1 |

*Plus:* **B** (B1–B24) is the *fixed-work register* in `docs/EXPLANATIONS.md` —
remediated bugs, separate from the 61 open. 6+13+4+12+7+9+9+1 = **61** ✓.

> "C-1 is the first of the six money-critical findings; the letters are just
> the bug-ledger categories, and the 61 sum checks."

---
*Every claim: see the roundup (`judges-roundup-2026-10-31.md`, canonical) or
`docs/perf/fp-209-loadtest-2026-09.md`.*
