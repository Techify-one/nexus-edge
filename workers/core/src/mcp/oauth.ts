import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { createId, type RequestPrincipal } from "@app/core-contract";
import { base64url } from "@app/webhook-contract";
import type { HonoEnv } from "../env.js";
import { loadPrincipalAccess } from "../lib/ability.js";
import { hashToken, randomToken } from "../lib/crypto.js";
import { AppError, noStore, parseBody } from "../lib/http.js";
import { parseJson } from "../lib/values.js";
import {
  authenticatePrincipal,
  consumePrincipalRateLimit,
} from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { loadMcpPlugins, permittedMcpActions } from "./tools.js";

const scope = "mcp:tools";
export const mcpResource = (c: Context<HonoEnv>) =>
  `${new URL(c.env.BETTER_AUTH_URL).origin}/mcp`;
const issuer = (c: Context<HonoEnv>) => new URL(c.env.BETTER_AUTH_URL).origin;
const oauthError = (
  c: Context<HonoEnv>,
  error: string,
  status: 400 | 401 = 400,
) => c.json({ error }, status, noStore);

export async function publicMcpRateLimit(c: Context<HonoEnv>): Promise<void> {
  const key = `${c.env.APP_INSTALLATION_ID}:mcp:public:${await hashToken(c.req.header("CF-Connecting-IP") ?? "unknown")}`;
  const now = Date.now();
  const result = await c.get("db").execute(
    `INSERT INTO "rateLimit"(id,key,count,last_request) VALUES (?, ?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN last_request <= ? THEN 1 ELSE count + 1 END, last_request = ? WHERE last_request <= ? OR count < 120`,
    [createId("rl"), key, now, now - 60_000, now, now - 60_000],
  );
  if (!result.rowsAffected)
    throw new AppError(429, "RATE_LIMITED", "Too many requests.");
}

export function validRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

const authorizationSchema = z.object({
  client_id: z.string().min(1).max(200),
  redirect_uri: z.string().max(2048),
  response_type: z.literal("code"),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  code_challenge_method: z.literal("S256"),
  resource: z.string().max(2048),
  scope: z.literal(scope).default(scope),
  state: z.string().max(2048).optional(),
});

async function authorization(c: Context<HonoEnv>, raw: unknown) {
  const parsed = authorizationSchema.safeParse(raw);
  if (!parsed.success)
    throw new AppError(
      400,
      "OAUTH_INVALID_REQUEST",
      "Invalid OAuth authorization request.",
    );
  const input = parsed.data;
  const client = await c
    .get("db")
    .first<{ id: string; name: string; redirects: string }>(
      `SELECT id, name, redirect_uris_json AS redirects FROM mcp_oauth_clients WHERE id = ?`,
      [input.client_id],
    );
  if (
    !client ||
    !validRedirect(input.redirect_uri) ||
    !parseJson<string[]>(client.redirects, []).includes(input.redirect_uri) ||
    input.resource !== mcpResource(c)
  )
    throw new AppError(
      400,
      "OAUTH_INVALID_REQUEST",
      "Invalid OAuth client, redirect URI or resource.",
    );
  return { input, client };
}

export const mcpDiscoveryRoutes = new Hono<HonoEnv>();
mcpDiscoveryRoutes.use("/.well-known/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  await next();
});
mcpDiscoveryRoutes.get("/.well-known/oauth-protected-resource", (c) =>
  c.json(
    {
      resource: mcpResource(c),
      authorization_servers: [issuer(c)],
      scopes_supported: [scope],
      bearer_methods_supported: ["header"],
    },
    200,
    noStore,
  ),
);
mcpDiscoveryRoutes.get("/.well-known/oauth-protected-resource/mcp", (c) =>
  c.json(
    {
      resource: mcpResource(c),
      authorization_servers: [issuer(c)],
      scopes_supported: [scope],
      bearer_methods_supported: ["header"],
    },
    200,
    noStore,
  ),
);
mcpDiscoveryRoutes.get("/.well-known/oauth-authorization-server", (c) =>
  c.json(
    {
      issuer: issuer(c),
      authorization_endpoint: `${issuer(c)}/app/mcp/authorize`,
      token_endpoint: `${issuer(c)}/oauth/token`,
      registration_endpoint: `${issuer(c)}/oauth/register`,
      revocation_endpoint: `${issuer(c)}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [scope],
    },
    200,
    noStore,
  ),
);

export const mcpOAuthRoutes = new Hono<HonoEnv>();
mcpOAuthRoutes.use("*", bodyLimit({ maxSize: 16 * 1024 }));
mcpOAuthRoutes.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "no-store");
  c.header("Pragma", "no-cache");
  await publicMcpRateLimit(c);
  await next();
});
mcpOAuthRoutes.options("*", (c) => {
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  return c.body(null, 204);
});
mcpOAuthRoutes.post("/register", async (c) => {
  const parsed = z
    .object({
      client_name: z.string().min(1).max(100).default("MCP client"),
      redirect_uris: z
        .array(z.string().max(2048).refine(validRedirect))
        .min(1)
        .max(10),
      token_endpoint_auth_method: z.literal("none").default("none"),
      grant_types: z
        .array(z.enum(["authorization_code", "refresh_token"]))
        .optional(),
      response_types: z.array(z.literal("code")).optional(),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return oauthError(c, "invalid_client_metadata");
  const input = parsed.data;
  const id = createId("mcp_client");
  await c
    .get("db")
    .execute(
      "INSERT INTO mcp_oauth_clients(id,name,redirect_uris_json,created_at) VALUES (?, ?, ?, ?)",
      [id, input.client_name, JSON.stringify(input.redirect_uris), Date.now()],
    );
  return c.json(
    {
      client_id: id,
      client_name: input.client_name,
      redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
    noStore,
  );
});

mcpOAuthRoutes.post("/token", async (c) => {
  if (
    !c.req.header("Content-Type")?.includes("application/x-www-form-urlencoded")
  )
    return oauthError(c, "invalid_request");
  const form = new URLSearchParams(await c.req.text());
  const clientId = form.get("client_id") ?? "";
  if (!clientId || form.get("resource") !== mcpResource(c))
    return oauthError(c, "invalid_target");
  const now = Date.now();
  const access = `mcp_access_${randomToken()}`;
  const refresh = `mcp_refresh_${randomToken()}`;
  const accessHash = await hashToken(access);
  const refreshHash = await hashToken(refresh);
  if (form.get("grant_type") === "authorization_code") {
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier))
      return oauthError(c, "invalid_grant");
    const hash = await hashToken(form.get("code") ?? "");
    const code = await c.get("db").first<{
      clientId: string;
      userId: string;
      redirectUri: string;
      resource: string;
      challenge: string;
      permissions: string;
      autoSyncActions: number;
      expires: number;
      consumed: number | null;
    }>(`SELECT client_id AS "clientId", user_id AS "userId", redirect_uri AS "redirectUri", resource, challenge, permissions_json AS permissions, auto_sync_actions AS "autoSyncActions", expires_at AS expires, consumed_at AS consumed FROM mcp_oauth_codes WHERE hash = ?`, [hash]);
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    if (
      !code ||
      code.clientId !== clientId ||
      code.redirectUri !== form.get("redirect_uri") ||
      code.resource !== mcpResource(c) ||
      code.challenge !== challenge ||
      Number(code.expires) <= now ||
      code.consumed !== null
    )
      return oauthError(c, "invalid_grant");
    const access = await loadPrincipalAccess(c.get("db"), {
      userId: code.userId,
      authMethod: "api_key",
      credentialScopes: parseJson(code.permissions, []),
    });
    if (!access || !Boolean(access.user.active))
      return oauthError(c, "invalid_grant");
    const consumed = await c
      .get("db")
      .execute(
        "UPDATE mcp_oauth_codes SET consumed_at = ? WHERE hash = ? AND consumed_at IS NULL AND expires_at > ?",
        [now, hash, now],
      );
    if (!consumed.rowsAffected) return oauthError(c, "invalid_grant");
    await c
      .get("db")
      .execute(
        "INSERT INTO mcp_oauth_grants(id,client_id,user_id,resource,permissions_json,auto_sync_actions,access_hash,refresh_hash,access_expires_at,refresh_expires_at,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          createId("mcp_grant"),
          clientId,
          code.userId,
          code.resource,
          code.permissions,
          code.autoSyncActions,
          accessHash,
          refreshHash,
          now + 3_600_000,
          now + 30 * 86_400_000,
          now,
        ],
      );
  } else if (form.get("grant_type") === "refresh_token") {
    if (form.has("scope") && form.get("scope") !== scope)
      return oauthError(c, "invalid_scope");
    const updated = await c
      .get("db")
      .execute(
        'UPDATE mcp_oauth_grants SET access_hash = ?, refresh_hash = ?, access_expires_at = ? WHERE refresh_hash = ? AND client_id = ? AND resource = ? AND refresh_expires_at > ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = mcp_oauth_grants.user_id AND u.active = ?)',
        [
          accessHash,
          refreshHash,
          now + 3_600_000,
          await hashToken(form.get("refresh_token") ?? ""),
          clientId,
          mcpResource(c),
          now,
          c.get("db").provider === "d1" ? 1 : true,
        ],
      );
    if (!updated.rowsAffected) return oauthError(c, "invalid_grant");
  } else return oauthError(c, "unsupported_grant_type");
  return c.json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope,
    },
    200,
    noStore,
  );
});

mcpOAuthRoutes.post("/revoke", async (c) => {
  const form = new URLSearchParams(await c.req.text());
  const hash = await hashToken(form.get("token") ?? "");
  await c
    .get("db")
    .execute(
      "UPDATE mcp_oauth_grants SET revoked_at = ? WHERE client_id = ? AND (access_hash = ? OR refresh_hash = ?)",
      [Date.now(), form.get("client_id") ?? "", hash, hash],
    );
  return c.body(null, 200);
});

export const mcpConsentRoutes = new Hono<HonoEnv>();
mcpConsentRoutes.get("/mcp/oauth/consent", async (c) => {
  const { input, client } = await authorization(c, c.req.query());
  const actions = permittedMcpActions(
    c,
    await loadMcpPlugins(c, undefined, true),
  );
  return c.json(
    {
      clientName: client.name,
      redirectOrigin: new URL(input.redirect_uri).origin,
      actions: actions.map(({ name, title, titles, destructive }) => ({
        name,
        title,
        titles,
        destructive,
      })),
    },
    200,
    noStore,
  );
});
mcpConsentRoutes.post("/mcp/oauth/authorize", async (c) => {
  if (c.get("principal").authMethod !== "cookie")
    throw new AppError(
      403,
      "FORBIDDEN",
      "Authorize MCP clients with your browser session.",
    );
  const body = await parseBody(
    c,
    z
      .object({
        request: z.record(z.string(), z.string()),
        approve: z.boolean(),
        autoSyncActions: z.boolean().default(false),
      })
      .strict(),
  );
  const { input, client } = await authorization(c, body.request);
  const redirect = new URL(input.redirect_uri);
  redirect.searchParams.set("iss", issuer(c));
  if (input.state !== undefined)
    redirect.searchParams.set("state", input.state);
  if (!body.approve) redirect.searchParams.set("error", "access_denied");
  else {
    const actions = permittedMcpActions(
      c,
      await loadMcpPlugins(c, undefined, true),
    );
    if (!actions.length)
      throw new AppError(
        422,
        "MCP_NO_ACTIONS",
        "Enable and select plugin actions before authorizing this connection.",
      );
    const permissions = [
      ...new Set(actions.flatMap((action) => action.delegatedPermissions)),
    ];
    const code = randomToken();
    await c
      .get("db")
      .execute(
        "INSERT INTO mcp_oauth_codes(hash,client_id,user_id,redirect_uri,resource,challenge,permissions_json,auto_sync_actions,expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          await hashToken(code),
          client.id,
          c.get("principal").userId,
          input.redirect_uri,
          input.resource,
          input.code_challenge,
          JSON.stringify(permissions),
          body.autoSyncActions ? 1 : 0,
          Date.now() + 300_000,
        ],
      );
    redirect.searchParams.set("code", code);
    await audit(c, "core.mcp.client_authorized", "core.mcp", client.id, {
      actionCount: actions.length,
      autoSyncActions: body.autoSyncActions,
    });
  }
  return c.json({ redirect: redirect.toString() }, 200, noStore);
});
type AvailableActions = ReturnType<typeof permittedMcpActions>;
function connectionPermissions(
  actions: AvailableActions,
  permissions: string[],
  autoSyncActions = false,
) {
  const granted = new Set(permissions);
  const current = new Set(
    actions.flatMap((action) => action.delegatedPermissions),
  );
  return {
    autoSyncActions,
    authorizedActionCount: autoSyncActions
      ? actions.length
      : actions.filter((action) =>
          action.permissions.every((key) => granted.has(key)),
        ).length,
    availableActionCount: actions.length,
    needsPermissionUpdate:
      !autoSyncActions &&
      (current.size !== granted.size ||
        [...current].some((key) => !granted.has(key))),
  };
}

mcpConsentRoutes.get("/me/mcp-connections", async (c) => {
  const [plugins, grants] = await Promise.all([
    loadMcpPlugins(c, undefined, true),
    c.get("db").query<{
      id: string;
      name: string;
      createdAt: number | string;
      permissions: string;
      autoSyncActions: number;
    }>(`SELECT g.id, c.name, g.created_at AS "createdAt", g.permissions_json AS permissions, g.auto_sync_actions AS "autoSyncActions" FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id = g.client_id WHERE g.user_id = ? AND g.resource = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > ? ORDER BY g.created_at DESC`, [c.get("principal").userId, mcpResource(c), Date.now()]),
  ]);
  const actions = permittedMcpActions(c, plugins);
  return c.json(
    {
      items: grants.map(({ permissions, autoSyncActions, ...grant }) => ({
        ...grant,
        ...connectionPermissions(
          actions,
          parseJson<string[]>(permissions, []),
          Boolean(autoSyncActions),
        ),
      })),
      actions: actions.map(({ name, title, titles, destructive }) => ({
        name,
        title,
        titles,
        destructive,
      })),
    },
    200,
    noStore,
  );
});
mcpConsentRoutes.post("/me/mcp-connections/:id/permissions", async (c) => {
  if (c.get("principal").authMethod !== "cookie")
    throw new AppError(
      403,
      "FORBIDDEN",
      "Review connection permissions with your browser session.",
    );
  const input = await parseBody(
    c,
    z
      .object({
        approvedActions: z.array(z.string().min(1).max(128)).max(5000),
        autoSyncActions: z.boolean().optional(),
      })
      .strict(),
  );
  const grant = await c.get("db").first<{
    id: string;
    name: string;
    createdAt: number | string;
    autoSyncActions: number;
  }>(`SELECT g.id, c.name, g.created_at AS "createdAt", g.auto_sync_actions AS "autoSyncActions" FROM mcp_oauth_grants g JOIN mcp_oauth_clients c ON c.id = g.client_id WHERE g.id = ? AND g.user_id = ? AND g.resource = ? AND g.revoked_at IS NULL AND g.refresh_expires_at > ?`, [c.req.param("id"), c.get("principal").userId, mcpResource(c), Date.now()]);
  if (!grant)
    throw new AppError(
      404,
      "MCP_CONNECTION_NOT_FOUND",
      "Connection not found.",
    );
  const actions = permittedMcpActions(
    c,
    await loadMcpPlugins(c, undefined, true),
  );
  const approved = new Set(input.approvedActions);
  if (
    approved.size !== actions.length ||
    actions.some(({ name }) => !approved.has(name))
  )
    throw new AppError(
      409,
      "MCP_CONSENT_CHANGED",
      "Available actions changed. Reload and review connection permissions again.",
    );
  const permissions = [
    ...new Set(actions.flatMap((action) => action.delegatedPermissions)),
  ];
  const autoSyncActions =
    input.autoSyncActions ?? Boolean(grant.autoSyncActions);
  const updated = await c
    .get("db")
    .execute(
      "UPDATE mcp_oauth_grants SET permissions_json = ?, auto_sync_actions = ? WHERE id = ? AND user_id = ? AND resource = ? AND revoked_at IS NULL AND refresh_expires_at > ?",
      [
        JSON.stringify(permissions),
        autoSyncActions ? 1 : 0,
        grant.id,
        c.get("principal").userId,
        mcpResource(c),
        Date.now(),
      ],
    );
  if (!updated.rowsAffected)
    throw new AppError(
      404,
      "MCP_CONNECTION_NOT_FOUND",
      "Connection not found.",
    );
  await audit(c, "core.mcp.client_permissions_updated", "core.mcp", grant.id, {
    actionCount: actions.length,
    autoSyncActions,
  });
  return c.json(
    {
      ...grant,
      ...connectionPermissions(actions, permissions, autoSyncActions),
    },
    200,
    noStore,
  );
});
mcpConsentRoutes.delete("/me/mcp-connections/:id", async (c) => {
  await c
    .get("db")
    .execute(
      "UPDATE mcp_oauth_grants SET revoked_at = ? WHERE id = ? AND user_id = ?",
      [Date.now(), c.req.param("id"), c.get("principal").userId],
    );
  await audit(c, "core.mcp.client_revoked", "core.mcp", c.req.param("id"));
  return c.body(null, 204);
});

export const requireMcpPrincipal: MiddlewareHandler<HonoEnv> = async (
  c,
  next,
) => {
  const bearer = c.req.header("Authorization")?.match(/^Bearer (.+)$/u)?.[1];
  c.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${issuer(c)}/.well-known/oauth-protected-resource/mcp", scope="${scope}"`,
  );
  if (bearer?.startsWith("mcp_access_")) {
    if (c.req.header("Cookie") || c.req.header("X-API-Key"))
      throw new AppError(
        401,
        "CONFLICTING_CREDENTIALS",
        "Send exactly one authentication method.",
      );
    const grant = await c.get("db").first<{
      id: string;
      userId: string;
      permissions: string;
      autoSyncActions: number;
    }>(`SELECT id, user_id AS "userId", permissions_json AS permissions, auto_sync_actions AS "autoSyncActions" FROM mcp_oauth_grants WHERE access_hash = ? AND resource = ? AND revoked_at IS NULL AND access_expires_at > ? AND refresh_expires_at > ?`, [await hashToken(bearer), mcpResource(c), Date.now(), Date.now()]);
    if (!grant)
      throw new AppError(
        401,
        "UNAUTHENTICATED",
        "Invalid or expired MCP access token.",
      );
    const principal: RequestPrincipal = {
      userId: grant.userId,
      authMethod: "api_key",
      credentialId: grant.id,
      credentialScopes: parseJson(grant.permissions, []),
    };
    // An explicitly approved automatic policy follows the account's current
    // permissions. Transport identity stays OAuth/API-key for audit and rate
    // limits; permittedMcpActions still enforces the current plugin allowlists.
    const access = await loadPrincipalAccess(
      c.get("db"),
      grant.autoSyncActions
        ? { userId: grant.userId, authMethod: "cookie" }
        : principal,
    );
    if (!access || !Boolean(access.user.active))
      throw new AppError(401, "UNAUTHENTICATED", "The account is inactive.");
    c.set("principal", principal);
    c.set("currentUser", access.user);
    c.set("ability", access.ability);
    await consumePrincipalRateLimit(c, principal);
    await next();
  } else {
    // API keys may also be supplied as Bearer tokens by MCP CLI clients.
    const headers = new Headers(c.req.raw.headers);
    if (bearer?.startsWith("app_")) {
      if (c.req.header("X-API-Key"))
        throw new AppError(
          401,
          "CONFLICTING_CREDENTIALS",
          "Send exactly one authentication method.",
        );
      headers.delete("Authorization");
      headers.set("X-API-Key", bearer);
    }
    await authenticatePrincipal(c, next, headers);
  }
  if (c.res.status !== 401) c.res.headers.delete("WWW-Authenticate");
};
