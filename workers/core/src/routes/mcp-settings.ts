import { Hono } from "hono";
import { z } from "zod";
import type { HonoEnv } from "../env.js";
import { AppError, noStore, parseBody } from "../lib/http.js";
import { dbTime } from "../lib/values.js";
import { loadMcpPlugins } from "../mcp/tools.js";
import { requirePermission } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

export const mcpSettingsRoutes = new Hono<HonoEnv>();

mcpSettingsRoutes.get(
  "/plugins/:pluginId/mcp",
  requirePermission("core.plugin.read"),
  async (c) => {
    const plugin = (await loadMcpPlugins(c, c.req.param("pluginId")))[0];
    if (!plugin)
      throw new AppError(
        404,
        "PLUGIN_NOT_INSTALLED",
        "Plugin is not installed.",
      );
    return c.json(
      { ...plugin, endpoint: `${new URL(c.env.BETTER_AUTH_URL).origin}/mcp` },
      200,
      noStore,
    );
  },
);

mcpSettingsRoutes.put(
  "/plugins/:pluginId/mcp",
  requirePermission("core.plugin.update"),
  async (c) => {
    const input = await parseBody(
      c,
      z
        .object({
          enabled: z.boolean(),
          allowedActions: z.array(z.string().min(1).max(128)).max(500),
        })
        .strict(),
    );
    const plugin = (await loadMcpPlugins(c, c.req.param("pluginId")))[0];
    if (!plugin)
      throw new AppError(
        404,
        "PLUGIN_NOT_INSTALLED",
        "Plugin is not installed.",
      );
    const allowedActions = [...new Set(input.allowedActions)];
    if (
      allowedActions.some(
        (name) => !plugin.actions.some((action) => action.name === name),
      ) ||
      (input.enabled && !plugin.actions.length)
    )
      throw new AppError(
        422,
        "MCP_ACTION_INVALID",
        "Select actions declared by this plugin.",
      );
    await c.get("db").execute(
      `INSERT INTO plugin_mcp_settings(plugin_id,enabled,allowed_actions_json,updated_at,updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, allowed_actions_json = excluded.allowed_actions_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [
        plugin.id,
        input.enabled ? 1 : 0,
        JSON.stringify(allowedActions),
        dbTime(c.get("db")),
        c.get("principal").userId,
      ],
    );
    await audit(c, "core.mcp.settings_updated", "core.plugin", plugin.id, {
      enabled: input.enabled,
      allowedActions,
    });
    return c.json(
      { ...plugin, enabled: input.enabled, allowedActions },
      200,
      noStore,
    );
  },
);
