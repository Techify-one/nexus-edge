import type { DatabasePort } from "@app/database";

const digestId = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `aud_${[...bytes]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

export async function pluginAudit(input: {
  db: DatabasePort;
  action: string;
  resourceType: string;
  resourceId: string;
  userId: string;
  requestId: string;
  logicalKey: string;
  metadata?: Record<string, string | number | boolean>;
}): Promise<void> {
  const id = await digestId(`${input.action}:${input.logicalKey}`);
  const insert =
    input.db.provider === "d1"
      ? `INSERT OR IGNORE INTO audit_log(
           id,request_id,user_id,auth_method,action,resource_type,resource_id,metadata_json,created_at
         ) VALUES (?,?,?,'internal',?,?,?,?,?)`
      : `INSERT INTO audit_log(
           id,request_id,user_id,auth_method,action,resource_type,resource_id,metadata_json,created_at
         ) VALUES (?,?,?,'internal',?,?,?,?,?) ON CONFLICT (id) DO NOTHING`;
  await input.db.execute(insert, [
    id,
    input.requestId,
    input.userId,
    input.action,
    input.resourceType,
    input.resourceId,
    JSON.stringify(input.metadata ?? {}),
    input.db.provider === "d1" ? Date.now() : new Date(),
  ]);
}
