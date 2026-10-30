import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

export interface CorsPluginOptions {
  allowOrigins: string[];
}

const ALLOW_HEADERS = "content-type, idempotency-key, authorization";
const ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";

/** True when the request origin is explicitly allowed, or when the operator
 *  opted into "any origin" with `CORS_ALLOW_ORIGINS=*`. With `*` the plugin
 *  reflects the request's Origin header (required because the spec forbids
 *  `Access-Control-Allow-Origin: *` together with `Allow-Credentials: true`),
 *  so one deployment works from any panel origin — localhost, LAN IP or
 *  hostname — without enumerating machines. */
export function isAllowedOrigin(origin: string, allowOrigins: string[]): boolean {
  if (allowOrigins.includes("*")) return true;
  return allowOrigins.includes(origin);
}

/**
 * Dependency-free CORS for the two browser surfaces (merchant dashboard and
 * ops console) that call the API cross-origin with cookies. Without it the
 * browser sends a preflight, Fastify answers 404, and every dashboard
 * request is silently blocked — a failure that only exists at runtime.
 */
export const corsPlugin = fp<CorsPluginOptions>(async (app: FastifyInstance, options): Promise<void> => {
  const { allowOrigins } = options;
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || origin === "" || !isAllowedOrigin(origin, allowOrigins)) {
      return;
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
    reply.header("Access-Control-Allow-Methods", ALLOW_METHODS);
    if (request.method === "OPTIONS") {
      await reply.code(204).send();
    }
  });
});