/**
 * Regression for admin-and-ops-gap-plan A1: bulkApproveMerchantsKyc must
 * only flip merchants currently `under_review` — the JSDoc contract on
 * BulkApproveMerchantsKycResult that the SQL previously ignored (rejected /
 * already-approved ids were force-approved). Runs against the real function
 * and a migrated Postgres, mirroring the route-level suite's fixture style.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { bulkApproveMerchantsKyc } from "./bulkKyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "bulkApproveGuard.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `bun run migrate` first)",
  );
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });
test.after(async () => {
  await pool.end();
});

test("bulk approve only flips merchants currently under_review", async () => {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role)
     VALUES ($1, 'unused', 'Guard Test', 'finance') RETURNING id`,
    [`guard-admin-${randomUUID()}@example.test`],
  );
  const adminUserId = admin.rows[0]!.id;

  const rejected = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Guard Rejected ${randomUUID()}`],
  );
  const underReview = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Guard UnderReview ${randomUUID()}`],
  );
  await pool.query(`UPDATE merchants SET onboarding_status = 'rejected', kyc_passed = false WHERE id = $1`, [
    rejected.rows[0]!.id,
  ]);
  await pool.query(`UPDATE merchants SET onboarding_status = 'under_review', kyc_passed = false WHERE id = $1`, [
    underReview.rows[0]!.id,
  ]);

  const result = await bulkApproveMerchantsKyc(pool, {
    merchantIds: [rejected.rows[0]!.id, underReview.rows[0]!.id],
    adminUserId,
  });

  assert.equal(result.approvedCount, 1);
  assert.deepEqual(result.approvedMerchantIds, [underReview.rows[0]!.id]);

  const states = await pool.query<{ id: string; onboarding_status: string; kyc_passed: boolean }>(
    `SELECT id, onboarding_status, kyc_passed FROM merchants WHERE id = ANY($1::uuid[])`,
    [[rejected.rows[0]!.id, underReview.rows[0]!.id]],
  );
  const byId = new Map(states.rows.map((r) => [r.id, r]));
  assert.equal(byId.get(rejected.rows[0]!.id)!.onboarding_status, "rejected");
  assert.equal(byId.get(rejected.rows[0]!.id)!.kyc_passed, false);
  assert.equal(byId.get(underReview.rows[0]!.id)!.onboarding_status, "approved");
  assert.equal(byId.get(underReview.rows[0]!.id)!.kyc_passed, true);
});
