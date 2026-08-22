import { createId, toIso } from "@app/core-contract";
import {
  stableJson,
  webhookEnvelopeSchema,
  type CoreEventType,
} from "@app/webhook-contract";
import type { Context } from "hono";
import type { SqlStatement } from "@app/database";
import type { HonoEnv } from "../env.js";
import { dbTime } from "../lib/values.js";

export type EventInput = {
  eventType: CoreEventType;
  resourceType: string;
  resourceId: string;
  resourceVersion?: number;
  data: Record<string, unknown>;
};

export async function commitWithEvent(
  c: Context<HonoEnv>,
  statements: SqlStatement[],
  input: EventInput,
): Promise<string> {
  const db = c.get("db");
  const principal = c.get("principal");
  const eventId = createId("evt");
  const now = Date.now();
  const envelope = webhookEnvelopeSchema.parse({
    id: eventId,
    eventType: input.eventType,
    eventVersion: 1,
    occurredAt: toIso(now),
    requestId: c.get("requestId"),
    resource: {
      type: input.resourceType,
      id: input.resourceId,
      version: input.resourceVersion ?? 1,
    },
    actor: { userId: principal.userId, authMethod: principal.authMethod },
    data: input.data,
  });
  const payloadText = stableJson(envelope);
  if (new TextEncoder().encode(payloadText).byteLength > 65_536)
    throw new Error("Webhook payload exceeds 64 KiB");
  await db.atomic([
    ...statements,
    {
      sql: `INSERT INTO core_events(id, event_type, event_version, resource_type, resource_id, resource_version, actor_user_id, auth_method, request_id, payload_text, occurred_at, status, created_at)
            VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      params: [
        eventId,
        input.eventType,
        input.resourceType,
        input.resourceId,
        input.resourceVersion ?? 1,
        principal.userId,
        principal.authMethod,
        c.get("requestId"),
        payloadText,
        dbTime(db, now),
        dbTime(db, now),
      ],
    },
  ]);
  c.executionCtx.waitUntil(
    c.env.WEBHOOK_QUEUE.send({ kind: "fanout", eventId }).catch(
      () => undefined,
    ),
  );
  return eventId;
}
