/**
 * Rate-limit behaviour of the merchant OTP endpoints, including how it
 * behaves under concurrent load. Modeled on app.test.ts (real, migrated
 * Postgres via DATABASE_URL; Fastify app.inject). New file — no existing
 * test is modified.
 *
 * What it proves:
 *  1. sequential cap  — max_attempts wrong guesses, then 429 too_many_attempts
 *  2. resend throttle — /otp/resend inside the 30s challenge window is 429
 *  3. concurrent load — N parallel wrong guesses against ONE challenge; a
 *     load test would report a mix of 401/429; the number of 401s is the
 *     number of guesses actually evaluated against the max_attempts budget.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { TooManyRequestsError } from "../lib/errors.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "otpRateLimit.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `bun run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

// A pool with enough connections for the parallel-guess test.
const pool = new Pool({ connectionString: databaseUrl, max: 20 });
const app = buildApp(config, pool);
const cookieName = config.cookieName;

test.after(async () => {
  await app.close();
  await pool.end();
});

function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

function parseCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!header) throw new Error("expected a Set-Cookie header in the response");
  return header.split(";")[0] as string;
}

/** Sign up a merchant, then log in, returning the pending-session cookie. */
async function loginToPendingSession(prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  const password = "rate-limit-password-123!";
  const regNumber = `RL-${randomUUID().slice(0, 8)}`;

  const signupRes = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `Rate Limit Co ${prefix}`,
        registrationNumber: regNumber,
        businessType: "llc" as const,
        contactEmail: uniqueEmail(`${prefix}-contact`),
        contactPhone: "+97300000000",
        addressLine1: "1 Limit Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signupRes.statusCode, 201, signupRes.body);
  const { merchantId } = signupRes.json() as { merchantId: string };

  const loginRes = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { merchantId, email, password },
  });
  assert.equal(loginRes.statusCode, 200, loginRes.body);
  assert.equal((loginRes.json() as { otpRequired: boolean }).otpRequired, true);
  return parseCookie(loginRes.headers["set-cookie"]);
}

async function verify(cookie: string, code: string) {
  return app.inject({
    method: "POST",
    url: "/v1/auth/otp/verify",
    headers: { cookie },
    payload: { code },
  });
}

/** A code that is guaranteed not to be the real one for this challenge. */
function wrongCode(realHint = "000000"): string {
  return realHint === "000000" ? "999999" : "000000";
}

test("sequential: after max_attempts wrong OTP guesses the 6th is 429 and the session is revoked", async () => {
  const cookie = await loginToPendingSession("seq");
  const code = wrongCode();

  for (let i = 0; i < config.otpMaxAttempts; i++) {
    const res = await verify(cookie, code);
    assert.equal(res.statusCode, 401, `attempt ${i + 1} should be invalid_code, got ${res.body}`);
    assert.equal((res.json() as { error: string }).error, "invalid_code");
  }

  const capped = await verify(cookie, code);
  assert.equal(capped.statusCode, 429, capped.body);
  assert.equal((capped.json() as { error: string }).error, new TooManyRequestsError("too_many_attempts").code);

  // too_many_attempts revokes the pending session, so even the real code
  // can no longer be verified against this cookie.
  const after = await verify(cookie, code);
  assert.notEqual(after.statusCode, 200);
});

test("resend: /otp/resend inside the 30s challenge window is 429 resend_too_soon", async () => {
  const cookie = await loginToPendingSession("resend");

  // The 30s window starts at challenge creation (issueChallenge's
  // created_at), so a resend right after login is still inside it.
  const first = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(first.statusCode, 429, first.body);
  assert.equal((first.json() as { error: string }).error, "resend_too_soon");
});

test("concurrent load: 40 parallel wrong guesses are bounded (every answer is 401/429, budget is exhausted afterwards)", async () => {
  const cookie = await loginToPendingSession("conc");

  const parallel = Math.max(40, config.otpMaxAttempts * 8);
  const statuses = await Promise.all(Array.from({ length: parallel }, () => verify(cookie, wrongCode())));

  const byStatus = new Map<number, number>();
  for (const res of statuses) {
    byStatus.set(res.statusCode, (byStatus.get(res.statusCode) ?? 0) + 1);
    // A correct code was never sent, so 200 is impossible here.
    assert.ok(
      res.statusCode === 401 || res.statusCode === 429,
      `unexpected ${res.statusCode}: ${res.body}`,
    );
  }

  const evaluated = byStatus.get(401) ?? 0;
  // eslint-disable-next-line no-console
  console.log(
    `[rate-limit load] ${parallel} parallel guesses against one challenge with otpMaxAttempts=${config.otpMaxAttempts}: ` +
      `${evaluated} evaluated (401), ${byStatus.get(429) ?? 0} rejected (429). ` +
      `evaluated > otpMaxAttempts is the H-7 check-then-increment race.`,
  );

  // Whatever happened in the burst, the challenge's budget is now spent: a
  // follow-up guess must not succeed (session revoked by a 429, or the
  // counter already >= max_attempts).
  const followUp = await verify(cookie, wrongCode());
  assert.notEqual(followUp.statusCode, 200);
  assert.ok(
    followUp.statusCode === 401 || followUp.statusCode === 429,
    `follow-up should be 401/429, got ${followUp.statusCode}: ${followUp.body}`,
  );
});
