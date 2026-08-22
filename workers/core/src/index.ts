import { Hono } from "hono";
import { apiReference } from "@scalar/hono-api-reference";
import { createDatabase } from "@app/database";
import type { CoreEnv, HonoEnv, WebhookQueueMessage } from "./env.js";
import { errorResponse, AppError } from "./lib/http.js";
import { OPENAPI_DOCUMENT } from "./lib/openapi.js";
import { enforceCookieOrigin, requirePrincipal } from "./middleware/auth.js";
import { requestContext, securityHeaders } from "./middleware/runtime.js";
import { installerRoutes } from "./routes/installer.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { managementRoutes } from "./routes/management.js";
import { publicRoutes } from "./routes/public.js";
import { reauthRoutes } from "./routes/reauth.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { dbTime } from "./lib/values.js";
import { deliverWebhook, fanoutEvent } from "./webhooks/consumer.js";

const app = new Hono<HonoEnv>();
app.use("*", securityHeaders);
app.use("/health", requestContext);
app.use("/api/*", requestContext);

app.get("/health", (c) =>
  c.json({
    ok: true,
    version: c.env.APP_VERSION,
    provider: c.env.DATABASE_PROVIDER,
  }),
);
app.route("/api/v1", publicRoutes);

app.all("/api/auth/*", async (c) => {
  const path = new URL(c.req.url).pathname;
  if (path.includes("/sign-up"))
    throw new AppError(
      404,
      "PUBLIC_SIGNUP_DISABLED",
      "Public registration is not available.",
    );
  if (path.includes("/sign-in")) {
    const state = await c
      .get("db")
      .first<{ bootstrapState: string }>(
        `SELECT bootstrap_state AS "bootstrapState" FROM app_settings WHERE id = 'system'`,
      );
    if (state?.bootstrapState !== "complete")
      throw new AppError(
        403,
        "BOOTSTRAP_INCOMPLETE",
        "Complete the initial setup before signing in.",
      );
  }
  return c.get("auth").handler(c.req.raw);
});

export const coreV1Routes = new Hono<HonoEnv>();
coreV1Routes.use("*", requirePrincipal, enforceCookieOrigin);
coreV1Routes.route("/", managementRoutes);
coreV1Routes.route("/auth", reauthRoutes);
coreV1Routes.route("/webhooks", webhookRoutes);
coreV1Routes.route("/", installerRoutes);
coreV1Routes.route("/p", gatewayRoutes);
coreV1Routes.get("/openapi.json", (c) => c.json(OPENAPI_DOCUMENT));
app.route("/api/v1", coreV1Routes);
app.get(
  "/api/docs",
  requirePrincipal,
  apiReference({
    spec: { content: OPENAPI_DOCUMENT },
    theme: "default",
    pageTitle: "Nexus Edge API",
  }),
);

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Resource not found.",
        requestId: c.get("requestId") || "unknown",
      },
    },
    404,
  ),
);
app.onError((error, c) => {
  if (error instanceof AppError) return errorResponse(c, error);
  console.error(
    JSON.stringify({
      requestId: c.get("requestId"),
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  return errorResponse(
    c,
    new AppError(500, "INTERNAL_ERROR", "An unexpected error occurred."),
  );
});

export type CoreAppType = typeof coreV1Routes;

async function consume(
  batch: MessageBatch<WebhookQueueMessage>,
  env: CoreEnv,
): Promise<void> {
  const db = await createDatabase(env);
  try {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "fanout")
          await fanoutEvent(db, env.WEBHOOK_QUEUE, message.body.eventId);
        else {
          const result = await deliverWebhook(db, env, message.body.deliveryId);
          if (!result.success) {
            message.retry(
              result.retryAfter
                ? { delaySeconds: result.retryAfter }
                : undefined,
            );
            continue;
          }
        }
        message.ack();
      } catch {
        message.retry();
      }
    }
  } finally {
    await db.close();
  }
}

async function scheduled(env: CoreEnv): Promise<void> {
  const db = await createDatabase(env);
  try {
    const pending = await db.query<{ id: string }>(
      `SELECT id FROM core_events WHERE status = 'pending' OR (status = 'leased' AND lease_expires_at < ?) ORDER BY created_at LIMIT 25`,
      [dbTime(db)],
    );
    for (const event of pending)
      await env.WEBHOOK_QUEUE.send({ kind: "fanout", eventId: event.id });
    const cutoff = dbTime(db, Date.now() - 30 * 86_400_000);
    await db.execute(
      `DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < ? LIMIT 100)`,
      [cutoff],
    );
    await db.execute(
      `DELETE FROM core_events WHERE id IN (SELECT id FROM core_events WHERE created_at < ? LIMIT 100)`,
      [cutoff],
    );
    await db.execute(
      `DELETE FROM api_idempotency_keys WHERE idempotency_key_hash IN (SELECT idempotency_key_hash FROM api_idempotency_keys WHERE expires_at < ? LIMIT 100)`,
      [dbTime(db)],
    );
  } finally {
    await db.close();
  }
}

export default {
  fetch: app.fetch,
  queue: (
    batch: MessageBatch<WebhookQueueMessage>,
    env: CoreEnv,
    context: ExecutionContext,
  ) => context.waitUntil(consume(batch, env)),
  scheduled: (
    _controller: ScheduledController,
    env: CoreEnv,
    context: ExecutionContext,
  ) => context.waitUntil(scheduled(env)),
} satisfies ExportedHandler<CoreEnv, WebhookQueueMessage>;
