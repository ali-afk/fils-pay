import type { Config } from "../config.js";

/**
 * OTP delivery stub. No real email/SMS integration exists or is needed at
 * this stage. Always logs a structured line; the raw code is only included
 * when `nodeEnv !== 'production'` AND the `otpDevExpose` knob is enabled, so
 * production never logs the code and dev logs it only when explicitly opted
 * in via `OTP_DEV_EXPOSE`.
 */
/** Subset of the Fastify logger, so tests can pass a stub. */
export interface MinimalLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
}

export function sendOtpCode(
  logger: MinimalLogger,
  config: Pick<Config, "nodeEnv" | "otpDevExpose">,
  recipient: { merchantUserId: string; email: string },
  code: string,
): void {
  if (config.nodeEnv !== "production" && config.otpDevExpose) {
    logger.info(
      { merchantUserId: recipient.merchantUserId, channel: "otp", code },
      "otp code generated (dev)",
    );
  } else {
    logger.info({ merchantUserId: recipient.merchantUserId, channel: "otp" }, "otp code generated");
  }
}
