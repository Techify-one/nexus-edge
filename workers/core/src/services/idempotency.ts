import { stableJson, sha256 } from "@app/webhook-contract";
import type { Context } from "hono";
import type { HonoEnv } from "../env.js";
import { AppError } from "../lib/http.js";
import { dbTime } from "../lib/values.js";

type StoredResult = {
  requestHash: string;
  responseStatus: number;
  responseBody: string;
};

export async function idempotencyLookup(
  c: Context<HonoEnv>,
  routeKey: string,
  requestBody: unknown,
  required = false,
): Promise<{
  keyHash: string;
  requestHash: string;
  replay?: { status: number; body: unknown };
} | null> {
  const rawKey = c.req.header("Idempotency-Key");
  if (!rawKey) {
    if (required || c.get("principal").authMethod !== "cookie")
      throw new AppError(
        400,
        "IDEMPOTENCY_KEY_REQUIRED",
        "Envie o header Idempotency-Key.",
      );
    return null;
  }
  if (rawKey.length < 16 || rawKey.length > 200)
    throw new AppError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be between 16 and 200 characters.",
    );
  const keyHash = await sha256(rawKey);
  const requestHash = await sha256(stableJson(requestBody));
  const existing = await c.get("db").first<StoredResult>(
    `SELECT request_hash AS "requestHash", response_status AS "responseStatus", response_body AS "responseBody"
       FROM api_idempotency_keys WHERE user_id = ? AND method = ? AND route_key = ? AND idempotency_key_hash = ?`,
    [c.get("principal").userId, c.req.method, routeKey, keyHash],
  );
  if (!existing) return { keyHash, requestHash };
  if (existing.requestHash !== requestHash)
    throw new AppError(
      409,
      "IDEMPOTENCY_CONFLICT",
      "This key has already been used with a different request body.",
    );
  return {
    keyHash,
    requestHash,
    replay: {
      status: Number(existing.responseStatus),
      body: JSON.parse(existing.responseBody) as unknown,
    },
  };
}

export async function saveIdempotency(
  c: Context<HonoEnv>,
  routeKey: string,
  state: { keyHash: string; requestHash: string } | null,
  status: number,
  body: unknown,
): Promise<void> {
  if (!state) return;
  const now = Date.now();
  await c.get("db").execute(
    `INSERT INTO api_idempotency_keys(user_id, method, route_key, idempotency_key_hash, request_hash, response_status, response_body, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.get("principal").userId,
      c.req.method,
      routeKey,
      state.keyHash,
      state.requestHash,
      status,
      JSON.stringify(body),
      dbTime(c.get("db"), now),
      dbTime(c.get("db"), now + 86_400_000),
    ],
  );
}
