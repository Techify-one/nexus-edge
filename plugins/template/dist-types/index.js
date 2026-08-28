import { Hono } from "hono";
const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, plugin: "template", version: "1.0.0" }));
app.use("/*", async (c, next) => {
    if (c.req.path === "/health")
        return next();
    const value = c.req.header("X-Plugin-Context");
    const installerValue = c.req.header("X-Plugin-Installer-Context");
    if (Boolean(value) === Boolean(installerValue))
        return c.json({
            error: {
                code: "MISSING_PLUGIN_CONTEXT",
                message: "Internal context required",
            },
        }, 401);
    try {
        const selected = value ?? installerValue;
        const normalized = selected.replaceAll("-", "+").replaceAll("_", "/");
        const context = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
        if (value) {
            if (!("userId" in context) ||
                !context.userId ||
                !context.requestId ||
                !Array.isArray(context.permissions))
                throw new Error("invalid context");
            c.set("pluginContext", context);
        }
        else {
            if (!("operationId" in context) ||
                context.pluginId !== "template" ||
                !context.operationId ||
                !context.requestId)
                throw new Error("invalid context");
            c.set("installerContext", context);
        }
    }
    catch {
        return c.json({
            error: {
                code: "INVALID_PLUGIN_CONTEXT",
                message: "Internal context is invalid",
            },
        }, 401);
    }
    await next();
});
app.get("/items", (c) => c.get("pluginContext")?.permissions.includes("template.item.read")
    ? c.json({ items: [] })
    : c.json({ error: { code: "FORBIDDEN", message: "Permission denied" } }, 403));
app.post("/__installer/smoke", (c) => c.get("installerContext")
    ? c.json({ ok: true, template: true })
    : c.json({
        error: {
            code: "INSTALLER_CONTEXT_REQUIRED",
            message: "Installer context required",
        },
    }, 403));
export default app;
