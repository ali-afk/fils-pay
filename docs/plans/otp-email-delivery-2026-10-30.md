# Plan: real OTP email delivery

> Placement note: lives at `docs/plans/` per the planning-lane contract. This is the
> how-we-will-do-it document for **making the one-time code actually reach the person
> who is logging in**. It changes no code itself; an implementing lane applies it.
> Built from four verified lane reports (delivery stub, runtime behavior, test coverage,
> bug-ledger cross-check) plus a lead-run probe, all dated 2026-10-30.

| | |
|---|---|
| **Author** | AI planning lane (OTP email delivery) |
| **Date** | 2026-10-30 |
| **Status** | PLAN ONLY — nothing implemented; no file outside `docs/plans/` is touched. |
| **Decision** | Deliver OTP codes by SMTP through a `nodemailer` transport behind a thin `DeliveryClient` interface in a new `apps/api/src/email/` module. Keep the code-only-in-dev console fallback unchanged. Use Mailpit as the local SMTP sink for dev and tests, and name Resend as the one-line swap (new client implementation plus `RESEND_API_KEY`). |

## Intent

Today the API mints a one-time code, logs it only in development, and never sends it
anywhere. In production the code is generated in memory, handed to a function whose whole
body is two `logger.info` calls, and then thrown away. Anyone who signs in through the
dashboard in production is stuck at the code prompt with no way to obtain a code.

This plan fixes exactly that. It does not fix the tenant-scoping or race defects that sit
next to the login flow (H-6 through H-10). Those are referenced in section 7 and must be
treated as a separate piece of work.

## 1. The question, restated

**What is the smallest correct change that makes an OTP code reach its recipient in
production, without weakening the "production never logs the code" guarantee and without
changing the `devOtpExpose` response behavior?**

The framing has three edges worth stating plainly:

1. **Delivery, not generation.** The code already exists and is correct enough for now.
   Nothing about `generateOtpCode`, `hashOtpCode`, `verifyOtpCode`, the challenge table,
   or the session flow needs to move for this work.
2. **A transport, not a provider SDK.** Any SMTP-capable relay works (the hosted box can
   point at whatever the team already pays for, and a local sink works for tests). That
   argues for SMTP plus `nodemailer`, not a vendor-specific client.
3. **A boot-time contract, not a runtime surprise.** A production process that has no
   mail configuration must refuse to start, exactly the way it already refuses to start
   without `SETTLEMENT_INTERNAL_TOKEN`. Otherwise a deploy silently ships an API where
   login is unreachable again.

## 2. What the code does today (grounded evidence)

Every anchor below was re-read in this session against the working tree on 2026-10-30.
The claim column is what we assert; the observation column is what the cited lines
actually say.

| # | Claim | Anchor | Observation |
|---|---|---|---|
| E1 | Merchant OTP delivery is a log-only stub | `apps/api/src/auth/notifier.ts:4-8` | Header says "OTP delivery stub. No real email/SMS integration exists or is needed at this stage." |
| E2 | Production branch logs no code | `apps/api/src/auth/notifier.ts:22-23` | `if (config.nodeEnv === "production")` logs `{ merchantUserId, channel: "otp" }` only. |
| E3 | Non-production branch logs the raw code | `apps/api/src/auth/notifier.ts:25-28` | Log object includes `code` and message is `"otp code generated (dev)"`. |
| E4 | Admin OTP delivery is the same stub | `apps/api/src/adminAuth/notifier.ts:4-8`, `:17-24` | Same branch shape, `adminUserId` and `channel: "admin_otp"`; no transport. |
| E5 | Those stubs have exactly three callers | `apps/api/src/routes/auth.ts:97`, `apps/api/src/routes/auth.ts:241-246`, `apps/api/src/routes/adminAuth.ts:91` | Merchant login, merchant resend, admin login. Each passes a real `email` field. |
| E6 | Config has no mail settings at all | `apps/api/src/config.ts:10-121` | `Config` carries pool, session, OTP, KYC, webhook, and acquirer fields. No host, port, user, password, or from-address. |
| E7 | The repo already has a fail-fast-at-boot precedent | `apps/api/src/config.ts:187-190` | `SETTLEMENT_INTERNAL_TOKEN` is required when `nodeEnv === "production"` and boot throws without it. |
| E8 | `otpDevExpose` defaults by environment | `apps/api/src/config.ts:211-212` | `otpDevExpose` defaults to `nodeEnv !== "production"`, so production responses never carry `devOtpCode`. |
| E9 | No mail library is installed | `apps/api/package.json:12-25` | Dependencies end at `sharp`. No nodemailer, sendgrid, postmark, mailgun, or SES client exists in the workspace. |
| E10 | The compose stack runs as production | `ops/.env.docker:10` | `NODE_ENV=production`, so compose takes the branch that omits the code. |
| E11 | The api service has no mail env | `ops/docker-compose.yml:69-88` | Only `DATABASE_URL` and `SETTLEMENT_INTERNAL_URL` are set for the api service. |
| E12 | The compose build is currently un-runnable | `ops/docker-compose.yml:72` | It builds from `ops/Dockerfile.node`, which does not exist in this tree. `ops/Dockerfile.go` is missing too. |
| E13 | The dashboards offer no email affordance | `apps/web/src/pages/dashboard-login/LoginPage.tsx:178-181`, `apps/admin/src/pages/login/LoginPage.tsx:111-114` | Both render a code only when `devOtpCode` is present. Otherwise the prompt says a code "was issued" and shows nothing else. |
| E14 | Tests cover hashing, never delivery | `apps/api/src/auth/otp.test.ts:1-3`, `apps/api/src/app.test.ts:34`, `apps/api/src/app.test.ts:100` | The pure unit file imports only generate/hash/verify. In the route suite, line 34 sets `OTP_DEV_EXPOSE=true` and line 100 asserts the login response carries `devOtpCode`. |
| E15 | Resend inserts a brand-new challenge row | `apps/api/src/routes/auth.ts:224`, `apps/api/src/auth/otp.ts:48`, `db/migrations/0011_otp_challenges.sql:16` | Fresh INSERT, and `attempt_count` defaults to 0. The comment above the route claims the budget is inherited; it is not. |
| E16 | OTP recipient lookup spans merchants | `apps/api/src/routes/auth.ts:78`, `apps/api/src/auth/users.ts:16-20` | The challenge is issued for `findOtpRecipient(email)` with no `merchant_id` predicate and no `ORDER BY`. |
| E17 | Promotion keeps the same token | `apps/api/src/auth/sessions.ts:58`, `apps/api/src/adminAuth/sessions.ts:74` | `UPDATE ... SET authenticated = true` on the row the pre-OTP cookie already points at. |
| E18 | Codes come from `Math.random` | `apps/api/src/lib/random.ts:4`, `apps/api/src/adminAuth/otp.ts:13` | `randomDigits` uses `Math.floor(Math.random() * max)`, while the admin JSDoc claims `crypto.randomInt`. |
| E19 | Runtime probe confirms the split | lead probe plus lane report R3; raw output in the Appendix after this table | dev logs `{ merchantUserId, channel: "otp", code }` with "otp code generated (dev)"; production logs `{ merchantUserId, channel: "otp" }` and never the code. |

The E19 probe is the load-bearing one: the production process does not just *skip a log*,
it produces the code and then discards it. There is no observable side effect that could
carry the code to a user.

**Probe artifact (verbatim; exit code 0).** Imported `sendOtpCode` from
`apps/api/src/auth/notifier.ts` and called it with a stub logger — development first,
production second, recipient `{ merchantUserId: "u-1", email: "merchant@example.com" }`,
code `"123456"`:

```json
[
  {
    "obj": {
      "merchantUserId": "u-1",
      "channel": "otp",
      "code": "123456"
    },
    "msg": "otp code generated (dev)"
  },
  {
    "obj": {
      "merchantUserId": "u-1",
      "channel": "otp"
    },
    "msg": "otp code generated"
  }
]
```

## 3. Verdict

**The OTP login flow is unreachable in production, and no amount of configuration changes
that today.** The notifier is a stub by design (E1, E4), config has nowhere to put SMTP
settings (E6), no mail client is installed (E9), and the compose environment that matches the
hosted box runs as production (E10). In that environment the code exists only in memory
during the request (E2, E19).

The fix is small and boring, which is the point. One delivery module, five config fields,
two rewired notifiers, three awaited call sites, a Mailpit sink for dev, and tests that
assert the code leaves the process with the right recipient and subject and never appears
in a production log line.

Two rules constrain the implementation:

- **Production log lines never gain a code.** Whatever the transport does, the production
  branch of both notifiers keeps its current payload shape. If a transport detail needs to
  be logged, log the provider message id, never the code.
- **No transport configured means the code is unreachable, so boot must fail.** A production
  process with `SMTP_HOST` or `EMAIL_FROM` unset should exit during `loadConfig`, not accept
  logins it cannot complete.

What this plan deliberately does **not** do: fix H-6 through H-10, change `Math.random`,
add SMS, add a template system, or touch the dashboards. The dashboards already display a
mismatched message ("A one-time code was issued..."), which becomes true once email lands.

## 4. Plan (smallest correct change)

Steps are in dependency order. Each names the exact file and function it changes, then the
command the implementing lane runs to prove the step worked. Run all commands from the
repo root unless a step says otherwise.

### Step 1: install the mail client

Files: `apps/api/package.json`, `bun.lock`.

```
cd apps/api && bun add nodemailer && bun add --dev @types/nodemailer
```

`@types/nodemailer` is a dev dependency because the runtime package does not guarantee its
own type declarations. If a later nodemailer ships types, `tsc` will tell you and the dev
dependency can be dropped. Keep the dependency in `apps/api`, not the root, because the API is the
only service that sends mail.

**VERIFY**

```
cd apps/api && bun -e 'import nm from "nodemailer"; console.log(typeof nm.createTransport)'
```

Expect `function`. Then `git diff --stat apps/api/package.json bun.lock` must show both
files changed.

### Step 2: extend `Config` and `loadConfig`

Files: `apps/api/src/config.ts` (the `Config` interface at lines 10-121, and `loadConfig`
at 179-262).

Add five fields, placed next to the existing OTP block so the file stays readable:

```ts
/** SMTP relay for OTP email. Null means "not configured" (allowed only outside production). */
smtpHost: string | null;
smtpPort: number;
smtpUser: string | null;
smtpPass: string | null;
/** Envelope From for OTP mail. Required in production. */
emailFrom: string | null;
```

In `loadConfig`, immediately after the `SETTLEMENT_INTERNAL_TOKEN` block (lines 187-190),
add the same posture:

```ts
const smtpHost = env.SMTP_HOST?.trim() || null;
const emailFrom = env.EMAIL_FROM?.trim() || null;
if (nodeEnv === "production" && (smtpHost === null || emailFrom === null)) {
  throw new Error("loadConfig: SMTP_HOST and EMAIL_FROM are required when NODE_ENV=production");
}
```

Return values:

```ts
smtpHost,
smtpPort: parseIntEnv(env.SMTP_PORT, 587),
smtpUser: env.SMTP_USER?.trim() || null,
smtpPass: env.SMTP_PASS || null,
emailFrom,
```

Empty strings become `null` on purpose: `createDeliveryClient` then has one condition to
test, and a stray `SMTP_HOST=` in a shell profile cannot masquerade as configuration.
`SMTP_PORT` defaults to 587 (submission), which is the safe default for a real relay.

**VERIFY**

```
NODE_ENV=production DATABASE_URL=postgres://x SETTLEMENT_INTERNAL_TOKEN=t \
ACQUIRER_CALLBACK_SIGNING_SECRET=s \
WEBHOOK_SECRET_ENCRYPTION_KEY=Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk= \
bun -e 'import { loadConfig } from "./apps/api/src/config.ts";
try { loadConfig(process.env); console.log("BOOTED"); }
catch (e) { console.log("THREW:", e.message); }'
```

Expect `THREW: loadConfig: SMTP_HOST and EMAIL_FROM are required when NODE_ENV=production`.
Repeat with `SMTP_HOST=smtp.example.test EMAIL_FROM=no-reply@filspay.test` added; expect
`BOOTED`. A `NODE_ENV=development` run with neither variable must also print `BOOTED`
(the null path).

### Step 3: add the delivery module

New file: `apps/api/src/email/delivery.ts`.

Design it as one interface, one factory, one send function:

```ts
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config.js";

/** What the notifiers depend on. A stub is one object literal in a test. */
export interface DeliveryClient {
  sendOtpEmail(recipientEmail: string, code: string): Promise<void>;
}

export type EmailSettings = Pick<
  Config,
  "smtpHost" | "smtpPort" | "smtpUser" | "smtpPass" | "emailFrom" | "otpTtlMinutes"
>;

export function createDeliveryClient(
  settings: EmailSettings,
  transport?: Pick<Transporter, "sendMail">,
): DeliveryClient | null {
  if (!settings.smtpHost || !settings.emailFrom) return null;

  const mailer = transport ?? nodemailer.createTransport(transportOptions(settings));

  return {
    async sendOtpEmail(recipientEmail: string, code: string): Promise<void> {
      await mailer.sendMail({
        from: settings.emailFrom!,
        to: recipientEmail,
        subject: "Your FilsPay one-time code",
        text: [
          `Your FilsPay one-time code is ${code}.`,
          `It expires in ${settings.otpTtlMinutes} minutes.`,
          "If you did not try to sign in, ignore this email.",
        ].join("\n"),
      });
    },
  };
}

/** Pure, so a test can assert TLS and auth shapes without opening a socket. */
export function transportOptions(settings: EmailSettings) {
  return {
    host: settings.smtpHost!,
    port: settings.smtpPort,
    secure: settings.smtpPort === 465,
    auth: settings.smtpUser ? { user: settings.smtpUser, pass: settings.smtpPass ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}
```

Notes for the implementer:

- The code goes in the **body**, never the subject line. Subjects leak into logs, mail
  previews, and notification banners.
- Do not add HTML. A short `text` body is enough, and it keeps the test assertion simple.
- Do not retry inside the client. Retrying a login after the challenge has been committed
  is a policy question, not a transport detail. The route's 5xx plus the resend endpoint
  already gives the user a recovery path.
- The `transport` parameter is the test seam. Production passes nothing.

**VERIFY**

```
bun -e 'import { createDeliveryClient } from "./apps/api/src/email/delivery.ts";
const on = createDeliveryClient({ smtpHost: "127.0.0.1", smtpPort: 1025, smtpUser: null, smtpPass: null, emailFrom: "no-reply@filspay.test", otpTtlMinutes: 10 }, { sendMail: async (m) => { console.log("TO:", m.to, "SUBJ:", m.subject); return {}; } });
await on.sendOtpEmail("merchant@example.test", "123456");
const off = createDeliveryClient({ smtpHost: null, smtpPort: 1025, smtpUser: null, smtpPass: null, emailFrom: "no-reply@filspay.test", otpTtlMinutes: 10 });
console.log("off is", off);'
```

Expect `TO: merchant@example.test SUBJ: Your FilsPay one-time code` and `off is null`.

### Step 4: build one client per process and rewire both notifiers

Files: `apps/api/src/app.ts`, `apps/api/src/fastify-instance.d.ts`,
`apps/api/src/auth/notifier.ts`, `apps/api/src/adminAuth/notifier.ts`.

1. `apps/api/src/fastify-instance.d.ts`: import `DeliveryClient` and add
   `delivery: DeliveryClient | null;` to the `FastifyInstance` augmentation.
2. `apps/api/src/app.ts`: add `delivery?: DeliveryClient | null;` to `BuildAppOptions`, and
   next to the `webhookTransport` decoration (line 47) add:

   ```ts
   app.decorate("delivery", options.delivery === undefined ? createDeliveryClient(config) : options.delivery);
   ```

   The `=== undefined` test is deliberate: a test can pass explicit `null` to prove the
   "no transport" branch, while production and route tests get the client built from config.
3. `apps/api/src/auth/notifier.ts`: change `sendOtpCode` to `async`, keep the existing
   `Pick<Config, "nodeEnv">` config type, add a fifth parameter
   `delivery: DeliveryClient | null`, and keep both existing log calls **exactly as they
   are**. After the log block, add:

   ```ts
   if (delivery === null && config.nodeEnv === "production") {
     throw new Error("sendOtpCode: production has no delivery client");
   }
   if (delivery !== null) {
     if (recipient.email === "") throw new Error("sendOtpCode: recipient email is empty");
     await delivery.sendOtpEmail(recipient.email, code);
   }
   ```

   The production throw is not redundant with `loadConfig`. It is the guarantee that a
   future refactor cannot reintroduce the silent-discard bug. The dev path with no delivery
   client stays console-only, which preserves today's local workflow.
4. `apps/api/src/adminAuth/notifier.ts`: mirror the same change in `sendAdminOtpCode`, with
   the error messages renamed and the same log payloads (no code in production).

**VERIFY**

```
cd apps/api && bun run typecheck
```

Expect exit 0. Then a behavior probe outside the test suite:

```
bun -e 'import { sendOtpCode } from "./apps/api/src/auth/notifier.ts";
const logs = []; const sent = [];
const logger = { info: (o, m) => logs.push({ o, m }) };
const delivery = { sendOtpEmail: async (to, code) => { sent.push({ to, code }); } };
await sendOtpCode(logger, { nodeEnv: "production" }, { merchantUserId: "u1", email: "a@example.test" }, "123456", delivery);
console.log(JSON.stringify({ prodLogHasCode: "code" in logs[0].o, sent }));'
```

Expect `prodLogHasCode:false` and `sent:[{"to":"a@example.test","code":"123456"}]`. Swap
`nodeEnv` to `"development"` and expect `prodLogHasCode:true` with the same send.

### Step 5: await the send at the three call sites

Files: `apps/api/src/routes/auth.ts:97`, `apps/api/src/routes/auth.ts:241-246`,
`apps/api/src/routes/adminAuth.ts:91`.

Change each call from a statement to an awaited call and pass `app.delivery` as the last
argument:

```ts
await sendOtpCode(request.log, app.config, { merchantUserId: recipient.id, email: recipient.email }, code, app.delivery);
```

Do not move the `devOtpExpose` response blocks (`auth.ts:112-114`, `auth.ts:249-251`,
`adminAuth.ts:105-107`). They are already correct: dev/test responses carry the code, and
production never does. Do not reorder the transaction or the cookie. The only ordering
point worth stating: the challenge and pending session are committed before the send. A
transport failure therefore leaves a usable challenge behind and the user can call
`/v1/auth/otp/resend`. That is acceptable, and the alternative (send inside the
transaction) would hold a database connection open across a network round-trip.

One edge case the resend path already has: `auth.ts:244` falls back to `email: ""` when the
user row is missing. The empty-email guard in step 4 turns that into a loud error instead
of a silent no-op, which is the right failure for a delivery path.

**VERIFY**

```
cd apps/api && bun run typecheck
grep -n "await sendOtpCode\|await sendAdminOtpCode" apps/api/src/routes/auth.ts apps/api/src/routes/adminAuth.ts
```

Expect exit 0 and three awaited call sites (two merchant, one admin).

### Step 6: tests

Files: new `apps/api/src/email/delivery.test.ts`, new
`apps/api/src/auth/notifier.test.ts`, new `apps/api/src/email/delivery.mailpit.test.ts`.

There is **no** `apps/api/src/routes/auth.test.ts` in this tree (the routes directory has
`health.test.ts`, `webhooks.test.ts`, and others, but no auth route file). The route-level
suite is `apps/api/src/app.test.ts`, and it is regression-locked. Do not edit it. The
coverage below sits one layer down, at the notifier and delivery boundary, which is where
the new behavior actually lives.

| Test file | Case | Assertion | Determinism |
|---|---|---|---|
| `email/delivery.test.ts` | no `smtpHost`/`emailFrom` | factory returns `null` | pure |
| `email/delivery.test.ts` | configured with fake transport | `sendMail` called once; `to` equals recipient; `subject` contains "FilsPay"; `text` contains the code | pure, transport injected |
| `email/delivery.test.ts` | port 465 | `transportOptions({ ... }).secure` is `true`; 587 is `false` | pure |
| `auth/notifier.test.ts` | production + fake delivery | log object has no `code` key; delivery called once with the code | pure |
| `auth/notifier.test.ts` | development + fake delivery | log object has the code; delivery still called when configured | pure |
| `auth/notifier.test.ts` | development + `null` delivery | resolves, no throw, no send (console fallback) | pure |
| `auth/notifier.test.ts` | production + `null` delivery | rejects | pure |
| `email/delivery.mailpit.test.ts` | real SMTP to Mailpit | after `sendOtpEmail` resolves, list `/api/v1/messages`, fetch the new id from `/api/v1/message/{ID}`, and assert its body contains the code | event-based, skipped unless `MAILPIT_SMTP_URL` is set |

Testing rules for these files:

- Use `node:test` like the rest of `apps/api`. Assert on parsed fields and sentinel values,
  never on full message prose.
- The integration test must not sleep. Await the SMTP send, then query Mailpit once. The
  SMTP `250` is issued only after Mailpit has stored the message, so a single follow-up
  read is deterministic. If it ever proves racy, wait on the Mailpit API with a bounded
  `AbortSignal`, never a fixed `setTimeout`.
- Gate the integration file on an env var so a bare `bun test` run does not require Docker:
  `test("...", { skip: !process.env.MAILPIT_SMTP_URL }, async () => { ... })`.

**VERIFY**

```
bun test apps/api/src/email apps/api/src/auth/notifier.test.ts
bun test apps/api/src/auth/otp.test.ts
```

Expect all new tests passing and the existing five OTP tests unchanged at 5 pass, 0 fail.
Then, with Mailpit up (section 6):

```
docker compose -f ops/docker-compose.yml up -d mailpit
MAILPIT_SMTP_URL=smtp://127.0.0.1:1025 bun test apps/api/src/email/delivery.mailpit.test.ts
```

### Step 7: ops, env, and docs wiring

Files: `ops/docker-compose.yml`, `ops/.env.docker`, `ops/README.md`, `docs/RUNBOOK.md`.

1. `ops/docker-compose.yml`: add a `mailpit` service (dev sink only), then wire the api
   service to it.

   ```yaml
   mailpit:
     image: axllent/mailpit:latest
     ports:
       - "1025:1025"   # SMTP
       - "8025:8025"   # web UI
   ```

   Under `api.environment`, add:

   ```yaml
   SMTP_HOST: mailpit
   SMTP_PORT: "1025"
   EMAIL_FROM: no-reply@filspay.local
   ```

   and add `mailpit` to the api's `depends_on`. Pin the image tag to a digest or a specific
   release tag before this ever runs on a shared box; `latest` is fine for a local sink
   only.
2. `ops/.env.docker`: add the same names with comments, marked dev-only. The file already
   sets `NODE_ENV=production` at line 10, so the compose-run API will now take the email
   path and deliver to Mailpit instead of resolving nothing. Do not put real credentials
   here: `ops/.env.docker` is tracked by git (verified with `git ls-files`), despite its own
   header claiming it is ignored.
3. `ops/README.md`: extend the "Required settings per service" table with one api row:
   `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM` (from `.env.docker` locally, from the host
   environment in production), plus `SMTP_USER`/`SMTP_PASS` when the relay needs auth. Add
   one line to "Quick start" for `mailpit`.
4. `docs/RUNBOOK.md`: add an "OTP email delivery" section with the production env rows and
   two operational checks: "sign in and confirm the mail arrives" and "no code appears in
   the API log". Document the Mailpit UI at `http://127.0.0.1:8025` for dev.

**VERIFY**

```
docker compose -f ops/docker-compose.yml config --quiet && echo CONFIG_OK
docker compose -f ops/docker-compose.yml up -d mailpit
curl -sf http://127.0.0.1:8025/api/v1/info >/dev/null && echo MAILPIT_OK
docker compose -f ops/docker-compose.yml config | grep -A3 "SMTP_HOST"
```

Expect `CONFIG_OK`, `MAILPIT_OK`, and the three SMTP keys under the api service.

Known blocker, out of this plan's scope: `ops/Dockerfile.node` and `ops/Dockerfile.go` are
not in the tree (E12), so `docker compose up api` cannot build today. Run Mailpit from
compose and the API from source for QA:

```
SMTP_HOST=127.0.0.1 SMTP_PORT=1025 EMAIL_FROM=no-reply@filspay.local \
NODE_ENV=development DATABASE_URL=<dev db> bun apps/api/src/index.ts
```

## 5. Tests + QA the implementing lane must run

**Automated, in order:**

| Command | What it proves | Expected |
|---|---|---|
| `cd apps/api && bun run typecheck` | the new module, config fields, and async notifiers typecheck | exit 0 |
| `bun test apps/api/src/email apps/api/src/auth/notifier.test.ts` | recipient, subject, body code, prod-no-code log, null-client branches | all pass |
| `bun test apps/api/src/auth/otp.test.ts` | the existing code/hash/verify suite is untouched | 5 pass, 0 fail |
| `MAILPIT_SMTP_URL=smtp://127.0.0.1:1025 bun test apps/api/src/email/delivery.mailpit.test.ts` | a real SMTP round-trip stores a message containing the code | 1 pass |
| `bun test apps/api/src/app.test.ts` (needs a migrated Postgres) | the route-level flows still work with no SMTP configured | unchanged from baseline |

The DB-backed suite is listed because it is the closest thing to a route test, not because
this change should alter it. If it fails for lack of a database, record that as an
environment gap, not a regression.

**Manual QA, merchant flow:**

1. Start Postgres, Mailpit, and the API from source with the dev env above.
2. Sign in through `apps/web` with a seeded merchant account.
3. Open `http://127.0.0.1:8025`. Confirm exactly one message, addressed to the account's
   `merchant_users.email`, subject "Your FilsPay one-time code", body containing the six
   digit code.
4. Enter the code in the dashboard. Confirm the session promotes and `/v1/auth/me` answers.
5. Trigger resend and confirm a second message arrives with a different code.
6. Check the API log: in development it must show `otp code generated (dev)` with the code
   field (existing behavior), and the email must still be sent.

**Manual QA, production posture:**

1. Run the API with `NODE_ENV=production` plus a real or Mailpit relay and all required
   envs. Sign in.
2. Confirm the mail arrives and the login completes.
3. Grep the process log for the code string: zero hits, and the line reads
   `otp code generated` with only `merchantUserId` and `channel`.
4. Start once with `EMAIL_FROM` unset. Confirm the process exits non-zero with the
   `loadConfig` error and never binds port 3000.
5. Repeat the sign-in for the admin console (`/admin`): the admin notifier must send too,
   with the same production-no-code guarantee.

## 6. Config/env/ops wiring

| Variable | Example | Required in production | Read by | Notes |
|---|---|---|---|---|
| `SMTP_HOST` | `smtp.resend.com` or `mailpit` | yes | `loadConfig`, `createDeliveryClient` | absent means null; boot throws in production |
| `SMTP_PORT` | `587`, `465`, `1025` | no, defaults `587` | `loadConfig` | `secure` is derived from 465 |
| `SMTP_USER` | relay username | no | `createDeliveryClient` | auth is attached only when this is set |
| `SMTP_PASS` | relay password or API key | no | `createDeliveryClient` | keep out of the repo, host env only |
| `EMAIL_FROM` | `no-reply@yourdomain` | yes | `loadConfig`, `createDeliveryClient` | must be a domain the relay is allowed to send for |

`NODE_ENV` keeps its current meaning. `OTP_DEV_EXPOSE` is untouched and still defaults to
non-production.

**Resend as the one-line swap.** If the team prefers an HTTP API over SMTP, the swap is one
new file plus one config field: `apps/api/src/email/resend.ts` implements the same
`DeliveryClient` with a `fetch` POST to `https://api.resend.com/emails` and
`Authorization: Bearer ${config.resendApiKey}`. Then `createDeliveryClient` returns that
implementation instead of the SMTP one. Add `RESEND_API_KEY` to `Config` with the same
production requirement. Nothing in the notifiers, routes, or tests changes because they
only know the interface. This plan implements SMTP only; Resend stays a documented
alternative, not a second code path.

**Local sink.** Mailpit gives SMTP on 1025 and a UI/API on 8025. It requires no account,
accepts any credentials, and does not deliver externally. That makes it safe for compose
and CI.

## 7. Security notes (adjacent findings, out of scope)

These are real defects in the same login path. This plan makes the code leave the process,
which raises their stakes, so the implementing lane must not present email delivery as a
security fix. Each finding stays owned by the bug ledger.

- **H-6, cross-tenant recipient** (`docs/bugs/H-6.md`; anchors `apps/api/src/routes/auth.ts:78`
  and `apps/api/src/auth/users.ts:16-20`). The code is issued to
  `findOtpRecipient(email)`, which resolves across every active merchant with no
  `merchant_id` filter and no `ORDER BY`. Once email works, a code for another tenant's
  user can land in a shared mailbox. Ship order recommendation: fix H-6 before turning on
  production email, or accept that the first real deployment can email the wrong tenant.
- **H-7, check-then-increment race** (`docs/bugs/H-7.md`; `apps/api/src/routes/auth.ts:144-167`
  and `apps/api/src/routes/adminAuth.ts:135-158`). Parallel guesses can all read
  `attempt_count = 0`. Email delivery does not change the code space, so this stays a live
  brute-force path. Keep the per-IP rate limits in place.
- **H-8, resend resets the guess budget** (`docs/bugs/H-8.md`; `apps/api/src/routes/auth.ts:224`
  and `apps/api/src/auth/otp.ts:48`). Each resend inserts a fresh row, so `attempt_count`
  restarts at 0 (default at `db/migrations/0011_otp_challenges.sql:16`). Email makes resend
  more visible to users, which makes this abuse path easier to exercise, not harder.
- **H-9, merchant verify keeps the short cookie** (`docs/bugs/H-9.md`; pending cookie at
  `apps/api/src/routes/auth.ts:99-105`, promotion at `apps/api/src/routes/auth.ts:175`).
  Admin verify reissues the cookie; merchant verify does not. Unrelated to delivery, still
  a 10-minute logout.
- **H-10, no token rotation on promote** (`docs/bugs/H-10.md`;
  `apps/api/src/auth/sessions.ts:58`, `apps/api/src/adminAuth/sessions.ts:74`). The same raw
  token planted before OTP becomes the authenticated session. This plan neither fixes nor
  worsens it.
- **Code randomness** (`apps/api/src/lib/random.ts:4`). `randomDigits` uses `Math.random`,
  while `apps/api/src/adminAuth/otp.ts:13` claims `crypto.randomInt`. Recommendation for the
  security lane: replace the body with `randomInt(0, 10 ** n)`-based sampling from
  `node:crypto` (rejection-sampling free), which touches exactly one function and one
  call path (`generateOtpCode` at `apps/api/src/auth/otp.ts:8`). Do it before exposing
  email delivery to the public demo.
- **Email-specific rules this plan does add.** Do not put the code in the subject. Do not
  log the code in production, in a transport error, or in a retry message. Keep SMTP
  credentials out of `ops/.env.docker`, which is tracked by git. Use a `From` address on a
  domain the relay authorizes, so the OTP is not flagged as spoofed.
- **No email to an empty address.** The guard in step 4 prevents a challenge from being
  created and then silently skipped, which is the exact failure mode this plan exists to
  remove.
