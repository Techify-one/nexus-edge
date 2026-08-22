import { createId } from "@app/core-contract";
import type { Context } from "hono";
import type { HonoEnv } from "../env.js";
import { dbTime } from "../lib/values.js";

const SECRET_KEYS = /password|token|secret|authorization|cookie|api.?key|url/iu;

export function sanitizeMetadata(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEYS.test(key) ? "[REDACTED]" : child,
    ]),
  );
}

export async function audit(
  c: Context<HonoEnv>,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const principal = c.get("principal");
  await c.get("db").execute(
    `INSERT INTO audit_log(id, request_id, user_id, auth_method, credential_id, action, resource_type, resource_id, metadata_json, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId("aud"),
      c.get("requestId"),
      principal.userId,
      principal.authMethod,
      principal.credentialId ?? null,
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(sanitizeMetadata(metadata)),
      c.req.header("CF-Connecting-IP") ?? null,
      c.req.header("User-Agent")?.slice(0, 500) ?? null,
      dbTime(c.get("db")),
    ],
  );
}

export async function auditAnonymous(
  c: Context<HonoEnv>,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await c.get("db").execute(
    `INSERT INTO audit_log(id, request_id, user_id, auth_method, credential_id, action, resource_type, resource_id, metadata_json, ip, user_agent, created_at)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      createId("aud"),
      c.get("requestId"),
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(sanitizeMetadata(metadata)),
      c.req.header("CF-Connecting-IP") ?? null,
      c.req.header("User-Agent")?.slice(0, 500) ?? null,
      dbTime(c.get("db")),
    ],
  );
}
