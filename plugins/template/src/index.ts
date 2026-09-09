import { Hono, type Context } from "hono";
import {
  createPluginDatabase,
  type PluginContextV1,
  type PluginDatabase,
  type PluginInstallerContextV1,
} from "@nexus/plugin-sdk/backend";

type Env = {
  Bindings: {
    DATABASE_PROVIDER: "d1" | "postgres";
    DB?: D1Database;
    HYPERDRIVE?: Hyperdrive;
    DATABASE_URL?: string;
  };
  Variables: {
    db: PluginDatabase;
    pluginContext?: PluginContextV1;
    installerContext?: PluginInstallerContextV1;
  };
};
const app = new Hono<Env>();

app.get("/health", (c) =>
  c.json({ ok: true, plugin: "template", version: "1.0.0" }),
);
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const value = c.req.header("X-Plugin-Context");
  const installerValue = c.req.header("X-Plugin-Installer-Context");
  if (Boolean(value) === Boolean(installerValue))
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
    const selected = value ?? installerValue!;
    const normalized = selected.replaceAll("-", "+").replaceAll("_", "/");
    const context = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as PluginContextV1 | PluginInstallerContextV1;
    if (value) {
      if (
        !("userId" in context) ||
        !context.userId ||
        !context.requestId ||
        !Array.isArray(context.permissions)
      )
        throw new Error("invalid context");
      c.set("pluginContext", context);
    } else {
      if (
        !("operationId" in context) ||
        context.pluginId !== "template" ||
        !context.operationId ||
        !context.requestId
      )
        throw new Error("invalid context");
      c.set("installerContext", context);
    }
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
  const db = await createPluginDatabase(c.env);
  c.set("db", db);
  try {
    await next();
  } finally {
    await db.close();
  }
});

const permitted = (c: Context<Env>, permission: string) =>
  Boolean(c.get("pluginContext")?.permissions.includes(permission));
const forbidden = () =>
  new Response(
    JSON.stringify({
      error: { code: "FORBIDDEN", message: "Permission denied" },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  );
const textField = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 120 ? normalized : null;
};

app.get("/items", async (c) => {
  if (!permitted(c, "template.item.read")) return forbidden();
  const items = await c.get("db").query<{
    id: string;
    name: string;
    createdAt: string | number | Date;
    updatedAt: string | number | Date;
  }>(
    `SELECT id, name, created_at AS "createdAt", updated_at AS "updatedAt"
       FROM template_records ORDER BY created_at DESC, id DESC LIMIT 100`,
  );
  return c.json({ items });
});

app.post("/items", async (c) => {
  if (!permitted(c, "template.item.create")) return forbidden();
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name = textField(body?.name);
  if (!name)
    return c.json(
      { error: { code: "INVALID_NAME", message: "Enter a valid name" } },
      422,
    );
  const id = `item_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = c.get("db").provider === "d1" ? Date.now() : new Date();
  await c
    .get("db")
    .execute(
      "INSERT INTO template_records(id,name,created_at,updated_at) VALUES (?, ?, ?, ?)",
      [id, name, now, now],
    );
  return c.json({ item: { id, name, createdAt: now, updatedAt: now } }, 201);
});

app.patch("/items/:id", async (c) => {
  if (!permitted(c, "template.item.update")) return forbidden();
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
  } | null;
  const name = textField(body?.name);
  if (!name)
    return c.json(
      { error: { code: "INVALID_NAME", message: "Enter a valid name" } },
      422,
    );
  const now = c.get("db").provider === "d1" ? Date.now() : new Date();
  const result = await c
    .get("db")
    .execute(
      "UPDATE template_records SET name = ?, updated_at = ? WHERE id = ?",
      [name, now, c.req.param("id")],
    );
  return result.rowsAffected
    ? c.json({ item: { id: c.req.param("id"), name, updatedAt: now } })
    : c.json({ error: { code: "NOT_FOUND", message: "Item not found" } }, 404);
});

app.delete("/items/:id", async (c) => {
  if (!permitted(c, "template.item.delete")) return forbidden();
  const result = await c
    .get("db")
    .execute("DELETE FROM template_records WHERE id = ?", [c.req.param("id")]);
  return result.rowsAffected
    ? c.body(null, 204)
    : c.json({ error: { code: "NOT_FOUND", message: "Item not found" } }, 404);
});

app.post("/__installer/smoke", async (c) => {
  const installer = c.get("installerContext");
  if (!installer)
    return c.json(
      {
        error: {
          code: "INSTALLER_CONTEXT_REQUIRED",
          message: "Installer context required",
        },
      },
      403,
    );
  const id = `smoke_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = c.get("db").provider === "d1" ? Date.now() : new Date();
  await c
    .get("db")
    .execute(
      "INSERT INTO template_records(id,name,created_at,updated_at) VALUES (?, ?, ?, ?)",
      [id, "Installer smoke", now, now],
    );
  const created = await c
    .get("db")
    .first<{ id: string }>("SELECT id FROM template_records WHERE id = ?", [
      id,
    ]);
  await c.get("db").execute("DELETE FROM template_records WHERE id = ?", [id]);
  return created?.id === id
    ? c.json({ ok: true, read: true, write: true })
    : c.json({ ok: false }, 500);
});

export default app;
