/**
 * Tests for the reporting consumer's LISTEN lifecycle:
 * - R13 NOTIFY debounce: unit tests on createTrailingDebounce, plus an
 *   integration test firing real pg_notify bursts at a live listener with
 *   an injected pass counter.
 * - R14 LISTEN reconnect: killing the listener's backend re-establishes a
 *   fresh LISTEN connection (observed under LISTENER_APPLICATION_NAME in
 *   pg_stat_activity), and stop() cancels any pending reconnect — no
 *   timer or connection outlives it.
 *
 * The pass function is injected (default: runConsumerPass) so the
 * integration tests count pass triggers deterministically without
 * depending on the shared outbox/cursor state of parallel suites.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import {
  createTrailingDebounce,
  startReportingConsumer,
  NOTIFY_DEBOUNCE_MS,
  LISTENER_APPLICATION_NAME,
} from "./listener.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("listener.test.ts requires DATABASE_URL to point at a real, migrated Postgres (run `bun run migrate` first)");
}

const pool = new Pool({ connectionString: databaseUrl, max: 5 });

test.after(async () => {
  await pool.end();
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(cond: () => boolean, deadlineMs: number, label: string): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function listenerPids(): Promise<number[]> {
  const result = await pool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND query ILIKE 'LISTEN %'`,
    [LISTENER_APPLICATION_NAME],
  );
  return result.rows.map((r) => r.pid);
}

async function waitForListenerPid(excludePid: number | undefined, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const pids = (await listenerPids()).filter((p) => p !== excludePid);
    if (pids.length === 1) return pids[0]!;
    await sleep(50);
  }
  throw new Error("timed out waiting for the reporting LISTEN backend");
}

async function assertNoListenerFor(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    assert.deepEqual(await listenerPids(), [], "a reconnect must never fire after stop()");
    await sleep(100);
  }
}

const idleConfig = {
  databaseUrl,
  pgPoolMax: 5,
  reportingPollIntervalMs: 60_000,
  consumerBatchLimit: 500,
};

const fastConfig = {
  databaseUrl,
  pgPoolMax: 5,
  reportingPollIntervalMs: 200,
  consumerBatchLimit: 500,
};

test("createTrailingDebounce: a burst of schedules within the window fires the action exactly once, after the last schedule", async () => {
  let fireCount = 0;
  const debounce = createTrailingDebounce(200, () => {
    fireCount += 1;
  });
  debounce.schedule();
  await sleep(100);
  debounce.schedule();
  await sleep(100);
  debounce.schedule();
  await waitUntil(() => fireCount === 1, 2_000, "the single coalesced fire");
  assert.equal(fireCount, 1);
  await sleep(400);
  assert.equal(fireCount, 1, "no second fire for the coalesced burst");
  debounce.cancel();
});

test("createTrailingDebounce: schedules separated by more than the window each fire", async () => {
  let fireCount = 0;
  const debounce = createTrailingDebounce(100, () => {
    fireCount += 1;
  });
  debounce.schedule();
  await sleep(300);
  assert.equal(fireCount, 1);
  debounce.schedule();
  await sleep(300);
  assert.equal(fireCount, 2);
  debounce.cancel();
});

test("createTrailingDebounce: cancel() prevents a pending fire", async () => {
  let fireCount = 0;
  const debounce = createTrailingDebounce(100, () => {
    fireCount += 1;
  });
  debounce.schedule();
  debounce.cancel();
  await sleep(300);
  assert.equal(fireCount, 0);
});

test("R13: a burst of NOTIFYs within one debounce window triggers exactly one consumer pass", async () => {
  let passCalls = 0;
  const handle = startReportingConsumer(pool, idleConfig, async () => {
    passCalls += 1;
  });
  try {
    await waitUntil(() => passCalls >= 1, 5_000, "the startup pass after LISTEN");
    const base = passCalls;

    for (let i = 0; i < 5; i += 1) {
      await pool.query(`SELECT pg_notify($1, $2)`, ["outbox_events_channel", JSON.stringify({ n: i })]);
      await sleep(100);
    }
    await sleep(200);
    assert.equal(passCalls, base, "no per-notification pass while the burst is inside the debounce window");

    await waitUntil(() => passCalls === base + 1, 5_000, "the single coalesced pass");
    await sleep(NOTIFY_DEBOUNCE_MS + 500);
    assert.equal(passCalls, base + 1, "no second pass after the debounce window elapsed");

    await pool.query(`SELECT pg_notify($1, $2)`, ["outbox_events_channel", JSON.stringify({ late: true })]);
    await waitUntil(() => passCalls === base + 2, 5_000, "the late notification's own pass");
  } finally {
    await handle.stop();
  }
});

test("R14: killing the LISTEN backend re-establishes a fresh LISTEN connection", async () => {
  const handle = startReportingConsumer(pool, fastConfig, async () => {});
  try {
    const pid1 = await waitForListenerPid(undefined, 5_000);
    await pool.query(`SELECT pg_terminate_backend($1)`, [pid1]);
    const pid2 = await waitForListenerPid(pid1, 10_000);
    assert.notEqual(pid1, pid2, "a fresh connection, not the dead one");
    assert.deepEqual(await listenerPids(), [pid2], "exactly one live listener");
  } finally {
    await handle.stop();
  }
});

test("R14: stop() cancels a pending reconnect — no listener outlives it", async () => {
  const handle = startReportingConsumer(pool, fastConfig, async () => {});
  let pid1: number;
  try {
    pid1 = await waitForListenerPid(undefined, 5_000);
    await pool.query(`SELECT pg_terminate_backend($1)`, [pid1]);
    // Stop immediately, before the capped-backoff reconnect timer fires.
    await handle.stop();
    // If stop() had left the timer running, a fresh backend would appear
    // within a few poll-cadence periods.
    await assertNoListenerFor(1_500);
  } finally {
    await handle.stop();
  }
  assert.equal((await listenerPids()).length, 0, "the dead backend is never replaced after stop()");
});
