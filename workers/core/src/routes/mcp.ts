import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { HonoEnv } from "../env.js";
import { AppError, noStore } from "../lib/http.js";
import {
  loadMcpPlugins,
  permittedMcpActions,
  actionRequest,
} from "../mcp/tools.js";
import { requireMcpPrincipal } from "../mcp/oauth.js";
import { enforceCookieOrigin } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { forwardPluginRequest } from "./gateway.js";

export const mcpRoutes = new Hono<HonoEnv>();
const versions = ["2025-03-26", "2025-06-18", "2025-11-25"];
mcpRoutes.use("*", bodyLimit({ maxSize: 256 * 1024 }));
mcpRoutes.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = c.env.TRUSTED_ORIGINS.split(",").map((value) => value.trim());
  if (origin && !allowed.includes(origin))
    throw new AppError(
      403,
      "INVALID_ORIGIN",
      "The request origin is not authorized.",
    );
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header(
      "Access-Control-Expose-Headers",
      "WWW-Authenticate, MCP-Protocol-Version",
    );
  }
  c.header("Cache-Control", "no-store");
  if (c.req.method === "OPTIONS") {
    c.header("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    c.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Accept, MCP-Protocol-Version, X-API-Key",
    );
    return c.body(null, 204);
  }
  await next();
});
mcpRoutes.use("*", requireMcpPrincipal, enforceCookieOrigin);
mcpRoutes.get("/", (c) => c.body(null, 405, { Allow: "POST" }));
mcpRoutes.delete("/", (c) => c.body(null, 405, { Allow: "POST" }));
mcpRoutes.post("/", async (c) => {
  if (!c.req.header("Content-Type")?.toLowerCase().includes("application/json"))
    return c.json({ error: "unsupported_media_type" }, 415, noStore);
  const protocol = c.req.header("MCP-Protocol-Version");
  if (protocol && !versions.includes(protocol))
    return c.json({ error: "unsupported_protocol_version" }, 400, noStore);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      },
      400,
      noStore,
    );
  }
  const parsed = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string().max(200), z.number()]).optional(),
      method: z.string().max(200),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .safeParse(body);
  if (!parsed.success)
    return c.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid request" },
      },
      400,
      noStore,
    );
  const message = parsed.data;
  if (message.id === undefined) return c.body(null, 202);
  const result = (value: unknown) =>
    c.json({ jsonrpc: "2.0", id: message.id, result: value }, 200, noStore);
  const error = (code: number, detail: string) =>
    c.json(
      { jsonrpc: "2.0", id: message.id, error: { code, message: detail } },
      200,
      noStore,
    );
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    return result({
      protocolVersion:
        typeof requested === "string" && versions.includes(requested)
          ? requested
          : versions[versions.length - 1],
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "nexus-edge",
        title: "Nexus Edge Hub",
        version: c.env.APP_VERSION,
      },
      instructions:
        "Only actions explicitly enabled by the Nexus administrator are available. Respect each tool schema and the user's intent. Automatic connections follow saved plugin actions; manual connections require a permission review in the hub. Refresh client tools after changes.",
    });
  }
  if (message.method === "ping") return result({});
  if (!["tools/list", "tools/call"].includes(message.method))
    return error(-32601, "Method not found");
  const actions = permittedMcpActions(
    c,
    await loadMcpPlugins(c, undefined, true),
  );
  if (message.method === "tools/list") {
    const cursor = message.params?.cursor;
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" || !/^\d{1,6}$/u.test(cursor))
    )
      return error(-32602, "Invalid cursor");
    const offset = Number(cursor ?? 0);
    return result({
      tools: actions.slice(offset, offset + 100).map((action) => ({
        name: action.name,
        title: action.title,
        description: action.description,
        inputSchema: action.inputSchema,
        annotations: {
          readOnlyHint: action.readOnly,
          destructiveHint: action.destructive,
          idempotentHint: action.idempotent,
          openWorldHint: true,
        },
        securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
        _meta: {
          securitySchemes: [{ type: "oauth2", scopes: ["mcp:tools"] }],
        },
      })),
      ...(offset + 100 < actions.length
        ? { nextCursor: String(offset + 100) }
        : {}),
    });
  }
  const action = actions.find(
    (candidate) => candidate.name === message.params?.name,
  );
  if (!action) return error(-32602, "Unknown or unavailable tool");
  try {
    const request = new Request(
      actionRequest(action, message.params?.arguments),
      {
        signal: AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(25_000),
        ]),
      },
    );
    await audit(c, "core.mcp.tool_started", "core.plugin", action.pluginId, {
      action: action.name,
    });
    const response = await forwardPluginRequest(
      c,
      action.pluginId,
      request,
      action.delegatedPermissions,
    );
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader)
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 1024 * 1024) {
          await reader.cancel();
          throw new AppError(
            413,
            "MCP_RESULT_TOO_LARGE",
            "Result too large. Use narrower filters or pagination.",
          );
        }
        chunks.push(chunk.value);
      }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    await audit(c, "core.mcp.tool_completed", "core.plugin", action.pluginId, {
      action: action.name,
      status: response.status,
    });
    return result({
      content: [
        {
          type: "text",
          text:
            text ||
            (response.ok
              ? "Operation completed."
              : `Operation failed (HTTP ${response.status}).`),
        },
      ],
      isError: !response.ok,
    });
  } catch (cause) {
    await audit(c, "core.mcp.tool_failed", "core.plugin", action.pluginId, {
      action: action.name,
      code: cause instanceof AppError ? cause.code : "MCP_TOOL_FAILED",
    });
    return result({
      content: [
        {
          type: "text",
          text:
            cause instanceof AppError
              ? cause.message
              : "The tool could not complete. Check the operation status before retrying.",
        },
      ],
      isError: true,
    });
  }
});
