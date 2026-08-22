import { Hono } from "hono";
import { createId } from "@app/core-contract";
import { reauthSchema } from "@app/api-contracts";
import type { HonoEnv } from "../env.js";
import { hashToken, randomToken } from "../lib/crypto.js";
import { AppError, noStore, parseBody } from "../lib/http.js";
import { dbTime } from "../lib/values.js";

export const reauthRoutes = new Hono<HonoEnv>();

reauthRoutes.post("/reauth", async (c) => {
  const input = await parseBody(c, reauthSchema);
  try {
    await c.get("auth").api.verifyPassword({
      body: { password: input.password },
      headers: c.req.raw.headers,
    });
  } catch {
    throw new AppError(401, "INVALID_PASSWORD", "Incorrect password.");
  }
  const token = randomToken(32);
  const now = Date.now();
  const principal = c.get("principal");
  await c.get("db").execute(
    `INSERT INTO api_reauth_tokens(token_hash, user_id, auth_method, credential_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      await hashToken(token),
      principal.userId,
      principal.authMethod,
      principal.credentialId ?? null,
      dbTime(c.get("db"), now + 600_000),
      dbTime(c.get("db"), now),
    ],
  );
  return c.json(
    {
      token,
      expiresAt: new Date(now + 600_000).toISOString(),
      id: createId("reauth"),
    },
    201,
    noStore,
  );
});
