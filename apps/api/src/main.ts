import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { ApiExceptionFilter, EnvelopeInterceptor } from "./http.js";
import { RuntimeConfigService } from "./config.service.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn", "log"] });
  const config = app.get(RuntimeConfigService);
  const express = app.getHttpAdapter().getInstance() as {
    set(name: string, value: unknown): void;
  };
  if (process.env.MEMO_BEHIND_TRUSTED_PROXY === "true") express.set("trust proxy", 1);
  app.use(securityHeaders);
  app.use(createRateLimiter());
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new EnvelopeInterceptor());
  app.enableShutdownHooks();
  app.enableCors({
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || config.value.platformOrigins.includes(origin)) return callback(null, true);
      if (config.value.environment === "local" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error("ORIGIN_NOT_ALLOWED"), false);
    },
    credentials: false,
    allowedHeaders: ["authorization", "content-type", "idempotency-key"],
  });
  const host = process.env.HOST || "127.0.0.1";
  if (config.value.environment !== "local" && host === "0.0.0.0" && process.env.MEMO_BEHIND_TRUSTED_PROXY !== "true") {
    throw new Error("PUBLIC_BIND_REQUIRES_TRUSTED_PROXY");
  }
  await app.listen(config.value.port, host);
}

interface MinimalRequest {
  method: string;
  path?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface MinimalResponse {
  setHeader(name: string, value: string): void;
  status(code: number): MinimalResponse;
  json(value: unknown): void;
}

function securityHeaders(_request: MinimalRequest, response: MinimalResponse, next: () => void): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (/\/(agent-sessions|wallet-sessions|wallet-login-intents|pairing-|management-drafts)/.test(_request.path || _request.url || "")) {
    response.setHeader("cache-control", "no-store");
  }
  next();
}

function createRateLimiter() {
  const buckets = new Map<string, { windowStart: number; count: number }>();
  return (request: MinimalRequest, response: MinimalResponse, next: () => void): void => {
    const path = request.path || request.url?.split("?")[0] || "/";
    if (!path.startsWith("/api/") || request.method === "GET") return next();
    const sensitive = /\/(agent-sessions|wallet-sessions|wallet-login-intents|pairing-|pairings|management-drafts)/.test(path);
    const limit = sensitive ? 20 : 60;
    const now = Date.now();
    const key = `${request.ip || request.socket?.remoteAddress || "unknown"}:${path}`;
    const current = buckets.get(key);
    const bucket = !current || now - current.windowStart >= 60_000 ? { windowStart: now, count: 0 } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) if (now - value.windowStart >= 60_000) buckets.delete(bucketKey);
    }
    response.setHeader("x-ratelimit-limit", String(limit));
    response.setHeader("x-ratelimit-remaining", String(Math.max(0, limit - bucket.count)));
    if (bucket.count <= limit) return next();
    response.status(429).json({
      schema: "memo.agent-api-result/1",
      ok: false,
      error: { code: "RATE_LIMITED", message: "RATE_LIMITED" },
    });
  };
}

await bootstrap();
