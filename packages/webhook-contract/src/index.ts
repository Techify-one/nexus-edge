import { z } from "zod";

export const CORE_EVENT_TYPES = [
  "core.user.created",
  "core.user.updated",
  "core.user.activated",
  "core.user.deactivated",
  "core.invitation.created",
  "core.invitation.accepted",
  "core.invitation.revoked",
  "core.group.created",
  "core.group.updated",
  "core.group.deleted",
  "core.group.member_added",
  "core.group.member_removed",
  "core.permission.granted",
  "core.permission.revoked",
  "core.plugin.installation_started",
  "core.plugin.installation_succeeded",
  "core.plugin.installation_failed",
  "core.plugin.uninstalled",
  "core.webhook_endpoint.created",
  "core.webhook_endpoint.updated",
  "core.webhook_endpoint.disabled",
  "core.webhook_endpoint.deleted",
  "core.webhook_endpoint.secret_rotated",
  "core.webhook.test",
] as const;

export const coreEventTypeSchema = z.enum(CORE_EVENT_TYPES);
export type CoreEventType = z.infer<typeof coreEventTypeSchema>;

export const webhookEnvelopeSchema = z.object({
  id: z.string().startsWith("evt_"),
  eventType: coreEventTypeSchema,
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  requestId: z.string(),
  resource: z.object({
    type: z.string(),
    id: z.string(),
    version: z.number().int().nonnegative(),
  }),
  actor: z.object({
    userId: z.string(),
    authMethod: z.enum(["cookie", "bearer", "api_key"]),
  }),
  data: z.record(z.string(), z.unknown()),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

const encoder = new TextEncoder();

export const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const fromBase64url = (value: string): Uint8Array => {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};

export async function hmacSha256(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
    ),
  );
}

export async function signWebhook(
  secret: string,
  eventId: string,
  timestamp: number,
  body: string,
): Promise<string> {
  return `v1=${await hmacSha256(secret, `${eventId}.${timestamp}.${body}`)}`;
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
  );
}

export function stableJson(value: unknown): string {
  const visit = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    return input;
  };
  return JSON.stringify(visit(value));
}
