import { createId } from "@app/core-contract";
import { signWebhook, sha256 } from "@app/webhook-contract";
import type { DatabasePort } from "@app/database";
import type { CoreEnv, WebhookQueueMessage } from "../env.js";
import { decryptSecret } from "../lib/crypto.js";
import { dbTime, parseJson } from "../lib/values.js";
import { validateWebhookUrl } from "./ssrf.js";

const BACKOFF_SECONDS = [30, 120, 600, 3_600, 21_600, 57_600] as const;

type EventRow = {
  id: string;
  eventType: string;
  resourceType: string;
  resourceId: string;
  payloadText: string;
};
type EndpointRow = { id: string; eventTypesJson: unknown };
type DeliveryRow = {
  id: string;
  attemptCount: number;
  eventId: string;
  payloadText: string;
  urlCiphertext: string;
  secretCiphertext: string;
  keyId: string;
};

const insertIgnore = (provider: "d1" | "postgres"): string =>
  provider === "d1"
    ? "INSERT OR IGNORE INTO webhook_deliveries(id, endpoint_id, event_id, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?)"
    : "INSERT INTO webhook_deliveries(id, endpoint_id, event_id, status, attempt_count, created_at, updated_at) VALUES (?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (endpoint_id,event_id) DO NOTHING";

export async function fanoutEvent(
  db: DatabasePort,
  queue: Queue<WebhookQueueMessage>,
  eventId: string,
): Promise<void> {
  const event = await db.first<EventRow>(
    `SELECT id, event_type AS "eventType", resource_type AS "resourceType", resource_id AS "resourceId", payload_text AS "payloadText" FROM core_events WHERE id = ?`,
    [eventId],
  );
  if (!event) return;
  const endpoints = await db.query<EndpointRow>(
    'SELECT id, event_types_json AS "eventTypesJson" FROM webhook_endpoints WHERE enabled = ?',
    [true],
  );
  const selected = endpoints.filter((endpoint) => {
    if (event.eventType === "core.webhook.test")
      return event.resourceId === endpoint.id;
    if (
      event.resourceType === "core.webhook" &&
      event.resourceId === endpoint.id
    )
      return false;
    return parseJson<string[]>(endpoint.eventTypesJson, []).includes(
      event.eventType,
    );
  });
  const now = dbTime(db);
  for (const endpoint of selected) {
    await db.execute(insertIgnore(db.provider), [
      createId("whd"),
      endpoint.id,
      event.id,
      now,
      now,
    ]);
  }
  const deliveries = await db.query<{ id: string }>(
    "SELECT id FROM webhook_deliveries WHERE event_id = ? AND status = 'pending'",
    [event.id],
  );
  for (const delivery of deliveries)
    await queue.send({ kind: "delivery", deliveryId: delivery.id });
  await db.execute(
    "UPDATE core_events SET status = 'completed', enqueued_at = ? WHERE id = ?",
    [dbTime(db), event.id],
  );
}

export async function deliverWebhook(
  db: DatabasePort,
  env: CoreEnv,
  deliveryId: string,
): Promise<{ success: boolean; retryAfter?: number }> {
  const delivery = await db.first<DeliveryRow>(
    `SELECT d.id, d.attempt_count AS "attemptCount", d.event_id AS "eventId", e.payload_text AS "payloadText",
            w.url_ciphertext AS "urlCiphertext", w.secret_ciphertext AS "secretCiphertext", w.key_id AS "keyId"
       FROM webhook_deliveries d JOIN core_events e ON e.id = d.event_id JOIN webhook_endpoints w ON w.id = d.endpoint_id
      WHERE d.id = ? AND w.enabled = ?`,
    [deliveryId, true],
  );
  if (!delivery) return { success: true };
  const url = validateWebhookUrl(
    await decryptSecret(delivery.urlCiphertext, env.WEBHOOK_ENCRYPTION_KEY),
    env.WEBHOOK_ALLOWED_DOMAINS,
  );
  const secret = await decryptSecret(
    delivery.secretCiphertext,
    env.WEBHOOK_ENCRYPTION_KEY,
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signWebhook(
    secret,
    delivery.eventId,
    timestamp,
    delivery.payloadText,
  );
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let response: Response | null = null;
  let errorMessage: string | null = null;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      body: delivery.payloadText,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "App-Webhooks/1.0",
        "Webhook-Id": delivery.eventId,
        "Webhook-Timestamp": String(timestamp),
        "Webhook-Key-Id": delivery.keyId,
        "Webhook-Signature": signature,
      },
    });
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message.slice(0, 300) : "network_error";
  }
  clearTimeout(timeout);
  const body = response
    ? new Uint8Array(await response.arrayBuffer())
    : new Uint8Array();
  const attemptCount = Number(delivery.attemptCount) + 1;
  const success = Boolean(
    response && response.status >= 200 && response.status < 300,
  );
  if (success) {
    await db.execute(
      `UPDATE webhook_deliveries SET status = 'delivered', attempt_count = ?, last_status_code = ?, last_error = NULL,
       response_body_sha256 = ?, response_size = ?, delivered_at = ?, updated_at = ? WHERE id = ?`,
      [
        attemptCount,
        response!.status,
        await sha256(body),
        body.byteLength,
        dbTime(db),
        dbTime(db),
        deliveryId,
      ],
    );
    return { success: true };
  }
  if (response?.status === 410) {
    await db.atomic([
      {
        sql: "UPDATE webhook_deliveries SET status = 'failed', attempt_count = ?, last_status_code = 410, last_error = 'gone', updated_at = ? WHERE id = ?",
        params: [attemptCount, dbTime(db), deliveryId],
      },
      {
        sql: "UPDATE webhook_endpoints SET enabled = ?, disabled_reason = '410 Gone', updated_at = ? WHERE id = (SELECT endpoint_id FROM webhook_deliveries WHERE id = ?)",
        params: [false, dbTime(db), deliveryId],
      },
    ]);
    return { success: true };
  }
  const retryAfterHeader = response?.headers.get("Retry-After");
  const parsedRetryAfter = retryAfterHeader
    ? Number(retryAfterHeader)
    : Number.NaN;
  const delay =
    response?.status === 429 && Number.isFinite(parsedRetryAfter)
      ? Math.min(86_400, Math.max(1, parsedRetryAfter))
      : BACKOFF_SECONDS[
          Math.min(attemptCount - 1, BACKOFF_SECONDS.length - 1)
        ]!;
  await db.execute(
    `UPDATE webhook_deliveries SET status = ?, attempt_count = ?, next_attempt_at = ?, last_status_code = ?, last_error = ?, response_body_sha256 = ?, response_size = ?, updated_at = ? WHERE id = ?`,
    [
      attemptCount > 6 ? "failed" : "retrying",
      attemptCount,
      dbTime(db, Date.now() + delay * 1000),
      response?.status ?? null,
      errorMessage ??
        `http_${response?.status ?? "error"}_${Date.now() - startedAt}ms`,
      body.byteLength ? await sha256(body) : null,
      body.byteLength,
      dbTime(db),
      deliveryId,
    ],
  );
  return attemptCount > 6
    ? { success: false }
    : { success: false, retryAfter: delay };
}
