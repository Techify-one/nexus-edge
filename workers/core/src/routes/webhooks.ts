import { Hono } from "hono";
import { webhookEndpointCreateSchema } from "@app/api-contracts";
import { CORE_EVENT_TYPES } from "@app/webhook-contract";
import { createId } from "@app/core-contract";
import type { HonoEnv } from "../env.js";
import { encryptSecret, randomToken } from "../lib/crypto.js";
import { AppError, noStore, parseBody } from "../lib/http.js";
import { dbTime, parseJson } from "../lib/values.js";
import { requirePermission } from "../middleware/auth.js";
import { requireRecentReauth } from "../middleware/reauth.js";
import { audit } from "../services/audit.js";
import { commitWithEvent } from "../services/events.js";
import { validateWebhookUrl } from "../webhooks/ssrf.js";

export const webhookRoutes = new Hono<HonoEnv>();

webhookRoutes.get("/event-types", requirePermission("core.webhook.read"), (c) =>
  c.json({ items: CORE_EVENT_TYPES }),
);

webhookRoutes.get(
  "/endpoints",
  requirePermission("core.webhook.read"),
  async (c) => {
    const rows = await c.get("db").query<Record<string, unknown>>(
      `SELECT id, name, enabled, host, event_types_json AS "eventTypes", key_id AS "keyId", created_at AS "createdAt", updated_at AS "updatedAt", disabled_reason AS "disabledReason"
       FROM webhook_endpoints ORDER BY created_at DESC`,
    );
    return c.json({
      items: rows.map((row) => ({
        ...row,
        url: `https://${String(row.host)}/…`,
        eventTypes: parseJson(row.eventTypes, []),
      })),
    });
  },
);

webhookRoutes.post(
  "/endpoints",
  requirePermission("core.webhook.create"),
  requireRecentReauth,
  async (c) => {
    const input = await parseBody(c, webhookEndpointCreateSchema);
    if (
      input.eventTypes.some(
        (type) => !(CORE_EVENT_TYPES as readonly string[]).includes(type),
      )
    )
      throw new AppError(
        422,
        "UNKNOWN_EVENT_TYPE",
        "One or more event types do not exist.",
      );
    const url = validateWebhookUrl(input.url, c.env.WEBHOOK_ALLOWED_DOMAINS);
    const secret = `whsec_${randomToken(32)}`;
    const id = createId("whe");
    const keyId = createId("key");
    const now = dbTime(c.get("db"));
    await commitWithEvent(
      c,
      [
        {
          sql: `INSERT INTO webhook_endpoints(id, name, enabled, host, url_ciphertext, event_types_json, secret_ciphertext, key_id, key_version, created_by_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          params: [
            id,
            input.name,
            true,
            url.hostname,
            await encryptSecret(url.toString(), c.env.WEBHOOK_ENCRYPTION_KEY),
            JSON.stringify(input.eventTypes),
            await encryptSecret(secret, c.env.WEBHOOK_ENCRYPTION_KEY),
            keyId,
            c.get("principal").userId,
            now,
            now,
          ],
        },
      ],
      {
        eventType: "core.webhook_endpoint.created",
        resourceType: "core.webhook",
        resourceId: id,
        data: {
          name: input.name,
          host: url.hostname,
          eventTypes: input.eventTypes,
        },
      },
    );
    await audit(c, "core.webhook_endpoint.created", "core.webhook", id, {
      host: url.hostname,
      eventTypes: input.eventTypes,
    });
    return c.json(
      {
        id,
        name: input.name,
        host: url.hostname,
        eventTypes: input.eventTypes,
        secret,
        keyId,
      },
      201,
      noStore,
    );
  },
);

webhookRoutes.patch(
  "/endpoints/:endpointId",
  requirePermission("core.webhook.update"),
  async (c) => {
    const input = await c.req.json<{
      name?: string;
      enabled?: boolean;
      eventTypes?: string[];
    }>();
    if (
      input.eventTypes?.some(
        (type) => !(CORE_EVENT_TYPES as readonly string[]).includes(type),
      )
    )
      throw new AppError(
        422,
        "UNKNOWN_EVENT_TYPE",
        "One or more event types do not exist.",
      );
    const id = c.req.param("endpointId");
    const current = await c
      .get("db")
      .first<{ name: string; enabled: number | boolean; eventTypes: unknown }>(
        `SELECT name, enabled, event_types_json AS "eventTypes" FROM webhook_endpoints WHERE id = ?`,
        [id],
      );
    if (!current)
      throw new AppError(404, "WEBHOOK_NOT_FOUND", "Endpoint not found.");
    const name = input.name?.trim() || current.name;
    const enabled = input.enabled ?? Boolean(current.enabled);
    const eventTypes =
      input.eventTypes ?? parseJson<string[]>(current.eventTypes, []);
    await commitWithEvent(
      c,
      [
        {
          sql: "UPDATE webhook_endpoints SET name = ?, enabled = ?, event_types_json = ?, updated_at = ? WHERE id = ?",
          params: [
            name,
            enabled,
            JSON.stringify(eventTypes),
            dbTime(c.get("db")),
            id,
          ],
        },
      ],
      {
        eventType: enabled
          ? "core.webhook_endpoint.updated"
          : "core.webhook_endpoint.disabled",
        resourceType: "core.webhook",
        resourceId: id,
        data: { name, enabled, eventTypes },
      },
    );
    await audit(c, "core.webhook_endpoint.updated", "core.webhook", id, {
      enabled,
      eventTypes,
    });
    return c.json({ id, name, enabled, eventTypes });
  },
);

webhookRoutes.delete(
  "/endpoints/:endpointId",
  requirePermission("core.webhook.delete"),
  requireRecentReauth,
  async (c) => {
    const id = c.req.param("endpointId");
    await commitWithEvent(
      c,
      [{ sql: "DELETE FROM webhook_endpoints WHERE id = ?", params: [id] }],
      {
        eventType: "core.webhook_endpoint.deleted",
        resourceType: "core.webhook",
        resourceId: id,
        data: { deleted: true },
      },
    );
    await audit(c, "core.webhook_endpoint.deleted", "core.webhook", id);
    return c.body(null, 204);
  },
);

webhookRoutes.post(
  "/endpoints/:endpointId/rotate-secret",
  requirePermission("core.webhook.update"),
  requireRecentReauth,
  async (c) => {
    const id = c.req.param("endpointId");
    const current = await c
      .get("db")
      .first<{ secret: string; version: number }>(
        `SELECT secret_ciphertext AS secret, key_version AS version FROM webhook_endpoints WHERE id = ?`,
        [id],
      );
    if (!current)
      throw new AppError(404, "WEBHOOK_NOT_FOUND", "Endpoint not found.");
    const secret = `whsec_${randomToken(32)}`;
    const keyId = createId("key");
    await commitWithEvent(
      c,
      [
        {
          sql: `UPDATE webhook_endpoints SET previous_secret_ciphertext = secret_ciphertext, previous_expires_at = ?, secret_ciphertext = ?, key_id = ?, key_version = ?, updated_at = ? WHERE id = ?`,
          params: [
            dbTime(c.get("db"), Date.now() + 86_400_000),
            await encryptSecret(secret, c.env.WEBHOOK_ENCRYPTION_KEY),
            keyId,
            Number(current.version) + 1,
            dbTime(c.get("db")),
            id,
          ],
        },
      ],
      {
        eventType: "core.webhook_endpoint.secret_rotated",
        resourceType: "core.webhook",
        resourceId: id,
        data: { keyId },
      },
    );
    await audit(c, "core.webhook_endpoint.secret_rotated", "core.webhook", id, {
      keyId,
    });
    return c.json({ id, secret, keyId }, 200, noStore);
  },
);

webhookRoutes.post(
  "/endpoints/:endpointId/test",
  requirePermission("core.webhook.test"),
  async (c) => {
    const endpointId = c.req.param("endpointId");
    const eventId = await commitWithEvent(c, [], {
      eventType: "core.webhook.test",
      resourceType: "core.webhook_test",
      resourceId: endpointId,
      data: { endpointId, test: true },
    });
    await audit(c, "core.webhook.test", "core.webhook", endpointId, {
      eventId,
    });
    return c.json({ eventId, queued: true }, 202);
  },
);

webhookRoutes.get(
  "/events",
  requirePermission("core.webhook.read"),
  async (c) =>
    c.json({
      items: await c
        .get("db")
        .query(
          `SELECT id, event_type AS "eventType", resource_type AS "resourceType", resource_id AS "resourceId", status, occurred_at AS "occurredAt", created_at AS "createdAt" FROM core_events ORDER BY created_at DESC LIMIT 100`,
        ),
    }),
);

webhookRoutes.get(
  "/deliveries",
  requirePermission("core.webhook.read"),
  async (c) =>
    c.json({
      items: await c
        .get("db")
        .query(
          `SELECT d.id, d.endpoint_id AS "endpointId", d.event_id AS "eventId", d.status, d.attempt_count AS "attemptCount", d.next_attempt_at AS "nextAttemptAt", d.last_status_code AS "lastStatusCode", d.last_error AS "lastError", d.delivered_at AS "deliveredAt", w.host FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id ORDER BY d.created_at DESC LIMIT 100`,
        ),
    }),
);

webhookRoutes.post(
  "/deliveries/:deliveryId/redeliver",
  requirePermission("core.webhook.redeliver"),
  async (c) => {
    const id = c.req.param("deliveryId");
    const result = await c
      .get("db")
      .execute(
        "UPDATE webhook_deliveries SET status = 'pending', attempt_count = 0, next_attempt_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?",
        [dbTime(c.get("db")), id],
      );
    if (!result.rowsAffected)
      throw new AppError(404, "DELIVERY_NOT_FOUND", "Delivery not found.");
    await c.env.WEBHOOK_QUEUE.send({ kind: "delivery", deliveryId: id });
    await audit(c, "core.webhook.redelivered", "core.webhook_delivery", id);
    return c.json({ id, queued: true }, 202);
  },
);
