import { Hono } from "hono";
import type { PluginContext } from "@app/core-contract";

type Env = {
  Bindings: { DATABASE_PROVIDER: "d1" | "postgres" };
  Variables: { pluginContext: PluginContext };
};
const app = new Hono<Env>();

app.get("/health", (c) =>
  c.json({ ok: true, plugin: "template", version: "1.0.0" }),
);
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const value = c.req.header("X-Plugin-Context");
  if (!value)
    return c.json(
      {
        error: {
          code: "MISSING_PLUGIN_CONTEXT",
          message: "Internal context required",
        },
      },
      401,
    );
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const context = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as PluginContext;
    if (
      !context.userId ||
      !context.requestId ||
      !Array.isArray(context.permissions)
    )
      throw new Error("invalid context");
    c.set("pluginContext", context);
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_PLUGIN_CONTEXT",
          message: "Internal context is invalid",
        },
      },
      401,
    );
  }
  await next();
});

app.get("/items", (c) =>
  c.get("pluginContext").permissions.includes("template.item.read")
    ? c.json({ items: [] })
    : c.json(
        { error: { code: "FORBIDDEN", message: "Permission denied" } },
        403,
      ),
);
app.post("/__installer/smoke", (c) => c.json({ ok: true, template: true }));

export default app;
