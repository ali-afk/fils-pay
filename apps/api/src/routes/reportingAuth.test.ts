/**
 * Route-level test for the reporting export-summary surface, following the
 * analytics.test.ts pattern: `app.inject(...)` against `buildApp()` and a
 * real, migrated Postgres (no DB mocking). Regression for R16/G4 of the
 * reporting-and-export gap plan: export-summary used to be registered
 * without `requireMerchantAuth`, so an anonymous call dereferenced
 * `request.merchantAuth!` and 500'd. This test pins the 401/200 contract.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "reportingAuth.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `bun run migrate` first)",
  );
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

function authHeader(rawKey: string) {
  return { authorization: `Bearer ${rawKey}` };
}

async function createApprovedMerchantWithApiKey(label: string) {
  const merchantResult = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Reporting Auth Test Merchant ${label} ${randomUUID()}`, 250],
  );
  const merchantId = merchantResult.rows[0]!.id;

  const userResult = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused-in-these-tests')
     RETURNING id`,
    [merchantId, `owner-${randomUUID()}@example.test`],
  );
  const ownerUserId = userResult.rows[0]!.id;

  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: ownerUserId, label });

  return { merchantId, rawKey: issued.rawKey };
}

test("export-summary returns 401 for an unauthenticated request", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(res.statusCode, 401);
});

test("export-summary returns 200 with numeric totals for an authenticated merchant", async () => {
  const { rawKey } = await createApprovedMerchantWithApiKey("export-summary");
  const res = await app.inject({
    method: "GET",
    url: "/v1/reporting/export-summary",
    headers: authHeader(rawKey),
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(typeof body.totalDays, "number");
  assert.equal(typeof body.grossFils, "number");
});
