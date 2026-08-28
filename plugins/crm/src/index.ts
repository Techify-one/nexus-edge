import { Hono, type Context } from "hono";
import { createDatabase } from "@app/database";
import {
  leadCreateSchema,
  leadUpdateSchema,
  listQuerySchema,
} from "@app/api-contracts";
import type { PluginContext, PluginInstallerContext } from "@app/core-contract";
import type { CrmEnv } from "./env.js";
import { LeadRepository } from "./repositories/leads.js";
import { LeadService } from "./services/leads.js";

const app = new Hono<CrmEnv>();

app.get("/health", (c) =>
  c.json({ ok: true, plugin: "crm", version: "1.0.0" }),
);
app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const encoded = c.req.header("X-Plugin-Context");
  const installerEncoded = c.req.header("X-Plugin-Installer-Context");
  if (Boolean(encoded) === Boolean(installerEncoded))
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
    const value = encoded ?? installerEncoded!;
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const context = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as PluginContext | PluginInstallerContext;
    if (encoded) {
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
        context.pluginId !== "crm" ||
        !context.operationId ||
        !context.requestId
      )
        throw new Error("invalid installer context");
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
  const db = await createDatabase(c.env);
  c.set("db", db);
  try {
    await next();
  } finally {
    await db.close();
  }
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
  const db = c.get("db");
  const id = `lead_smoke_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = db.provider === "d1" ? Date.now() : new Date();
  await db.execute(
    "INSERT INTO crm_leads(id,name,email,status,owner_user_id,version,created_at,updated_at) VALUES (?, ?, ?, 'new', ?, 1, ?, ?)",
    [
      id,
      "Installer smoke",
      `${id}@invalid.example`,
      installer.operationId,
      now,
      now,
    ],
  );
  const created = await db.first<{ id: string }>(
    "SELECT id FROM crm_leads WHERE id = ?",
    [id],
  );
  await db.execute("DELETE FROM crm_leads WHERE id = ?", [id]);
  return created?.id === id
    ? c.json({ ok: true, read: true, write: true })
    : c.json({ ok: false }, 500);
});

const service = (c: Context<CrmEnv>) =>
  new LeadService(
    new LeadRepository(c.get("db")),
    c.get("pluginContext") ??
      (() => {
        throw new Error("FORBIDDEN:user-context");
      })(),
  );

export const crmRoutes = new Hono<CrmEnv>()
  .get("/leads", async (c) => {
    const query = listQuerySchema.parse(c.req.query());
    return c.json({ items: await service(c).list(query.limit, query.search) });
  })
  .post("/leads", async (c) => {
    const input = leadCreateSchema.parse(await c.req.json());
    return c.json(await service(c).create(input), 201);
  })
  .get("/leads/:leadId", async (c) => {
    const lead = await service(c).get(c.req.param("leadId"));
    return lead
      ? c.json(lead)
      : c.json(
          { error: { code: "NOT_FOUND", message: "Lead not found" } },
          404,
        );
  })
  .patch("/leads/:leadId", async (c) => {
    const input = leadUpdateSchema.parse(await c.req.json());
    const cleanInput = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as Parameters<LeadService["update"]>[1];
    const lead = await service(c).update(c.req.param("leadId"), cleanInput);
    return lead
      ? c.json(lead)
      : c.json(
          {
            error: {
              code: "VERSION_CONFLICT",
              message: "Lead changed or does not exist",
            },
          },
          409,
        );
  })
  .delete("/leads/:leadId", async (c) =>
    (await service(c).delete(c.req.param("leadId")))
      ? c.body(null, 204)
      : c.json(
          { error: { code: "NOT_FOUND", message: "Lead not found" } },
          404,
        ),
  );

app.route("/", crmRoutes);
app.onError((error, c) =>
  error.message.startsWith("FORBIDDEN:")
    ? c.json(
        { error: { code: "FORBIDDEN", message: "Permission denied" } },
        403,
      )
    : c.json(
        {
          error: { code: "INTERNAL_ERROR", message: "Unexpected plugin error" },
        },
        500,
      ),
);

export type CrmAppType = typeof crmRoutes;
export default app;
