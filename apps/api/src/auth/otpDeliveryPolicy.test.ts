import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.js";
import { sendOtpCode, type MinimalLogger } from "./notifier.js";

function captureLogger(): {
  logs: Array<{ obj: Record<string, unknown>; msg: string }>;
  logger: MinimalLogger;
} {
  const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger: MinimalLogger = {
    info: (obj, msg) => {
      logs.push({ obj, msg });
    },
  };
  return { logs, logger };
}

function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    DATABASE_URL: "postgres://unused/unused",
    NODE_ENV: "development",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    ...env,
  });
}

test("production with OTP_DEV_EXPOSE on never logs the raw code", () => {
  const config = testConfig({
    NODE_ENV: "production",
    OTP_DEV_EXPOSE: "true",
    SETTLEMENT_INTERNAL_TOKEN: "test-token",
    ACQUIRER_CALLBACK_SIGNING_SECRET: "test-secret",
  });
  assert.equal(config.otpDevExpose, true);
  const { logs, logger } = captureLogger();
  sendOtpCode(logger, config, { merchantUserId: "u1", email: "a@example.com" }, "123456");
  assert.equal(logs.length, 1);
  assert.ok(!("code" in logs[0].obj));
  assert.equal(logs[0].msg, "otp code generated");
});

test("development with the knob off logs no raw code (default false)", () => {
  const config = testConfig();
  assert.equal(config.otpDevExpose, false);
  const { logs, logger } = captureLogger();
  sendOtpCode(logger, config, { merchantUserId: "u1", email: "a@example.com" }, "123456");
  assert.equal(logs.length, 1);
  assert.ok(!("code" in logs[0].obj));
  assert.equal(logs[0].msg, "otp code generated");
});

test("development with the knob on logs the raw code", () => {
  const config = testConfig({ OTP_DEV_EXPOSE: "true" });
  assert.equal(config.otpDevExpose, true);
  const { logs, logger } = captureLogger();
  sendOtpCode(logger, config, { merchantUserId: "u1", email: "a@example.com" }, "123456");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].obj.code, "123456");
  assert.equal(logs[0].msg, "otp code generated (dev)");
});
