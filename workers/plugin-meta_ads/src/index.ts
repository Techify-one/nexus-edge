import { Hono, type Context } from "hono";
import { createDatabase } from "@app/database";
import type { PluginContext } from "@app/core-contract";
import { z } from "zod";
import type { MetaAdsEnv } from "./env.js";
import {
  MetaApiError,
  discoverAccounts,
  extractMetaPurchases,
  getObjectAccountId,
  inspectAccount,
  listAds,
  listAdSets,
  listCampaigns,
  listInsights,
  normalizeAccountId,
  setObjectStatus,
  validateDateRange,
} from "./meta-client.js";
import { AccountRepository } from "./repository.js";

const app = new Hono<MetaAdsEnv>();

const accountInput = z.object({
  name: z.string().trim().min(2).max(120),
  adAccountId: z.string().trim().min(6).max(34),
  enabled: z.boolean().default(true),
});
const accountUpdateInput = accountInput.extend({
  version: z.number().int().positive(),
});
const statusInput = z.object({
  objectId: z.string().trim(),
  objectType: z.enum(["campaign", "adset", "ad"]),
  status: z.enum(["ACTIVE", "PAUSED"]),
});
const insightQueryInput = z.object({
  accountIds: z.array(z.string().trim()).min(1).max(20),
  adIds: z.array(z.string().trim()).min(1).max(2_000),
  since: z.string().trim(),
  until: z.string().trim(),
  hideTestData: z.boolean().optional().default(true),
});

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await task(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

const repository = (c: Context<MetaAdsEnv>) =>
  new AccountRepository(c.get("db"));

const requirePermission = (c: Context<MetaAdsEnv>, permission: string) => {
  if (!c.get("pluginContext").permissions.includes(permission))
    throw new MetaApiError("FORBIDDEN", "Permission denied.", 403);
};

const parseCsv = (value: string | undefined, max: number): string[] => {
  const items = (value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length)
    throw new MetaApiError(
      "VALIDATION_ERROR",
      "Select at least one item.",
      400,
    );
  if (items.length > max)
    throw new MetaApiError(
      "VALIDATION_ERROR",
      `Select at most ${max} items.`,
      400,
    );
  return [...new Set(items)];
};

const assertConfiguredAccounts = async (
  c: Context<MetaAdsEnv>,
  requested: string[],
): Promise<string[]> => {
  const normalized = requested.map(normalizeAccountId);
  const enabled = await repository(c).enabledAccountIds();
  if (normalized.some((id) => !enabled.has(id)))
    throw new MetaApiError(
      "AD_ACCOUNT_NOT_CONFIGURED",
      "One or more ad accounts are not enabled in this plugin.",
      403,
    );
  return normalized;
};

const assertConfiguredCampaigns = async (
  c: Context<MetaAdsEnv>,
  accountIds: string[],
  campaignIds: string[],
): Promise<void> => {
  const signal = c.req.raw.signal;
  const campaigns = await mapWithConcurrency(accountIds, 3, (accountId) =>
    listCampaigns(c.env, accountId, signal),
  );
  const allowed = new Set(campaigns.flat().map((campaign) => campaign.id));
  if (campaignIds.some((campaignId) => !allowed.has(campaignId)))
    throw new MetaApiError(
      "AD_ACCOUNT_NOT_CONFIGURED",
      "One or more campaigns do not belong to a requested enabled ad account.",
      403,
    );
};

const insightItems = async (
  c: Context<MetaAdsEnv>,
  accountIds: string[],
  adIds: string[],
  since: string,
  until: string,
) => {
  validateDateRange(since, until);
  const batches: Array<{ accountId: string; adIds: string[] }> = [];
  for (const accountId of accountIds)
    for (let offset = 0; offset < adIds.length; offset += 100)
      batches.push({ accountId, adIds: adIds.slice(offset, offset + 100) });
  const rows = await mapWithConcurrency(batches, 3, (batch) =>
    listInsights(
      c.env,
      batch.accountId,
      batch.adIds,
      since,
      until,
      c.req.raw.signal,
    ),
  );
  return rows.flat().map((row) => ({
    adId: row.ad_id,
    adName: row.ad_name || row.ad_id,
    spend: Number(row.spend || 0),
    clicks: Number(row.inline_link_clicks || 0),
    impressions: Number(row.impressions || 0),
    purchases: extractMetaPurchases(row.actions),
  }));
};

app.get("/health", (c) =>
  c.json({ ok: true, plugin: "meta_ads", version: "1.0.1" }),
);

app.use("/*", async (c, next) => {
  if (c.req.path === "/health") return next();
  const encoded = c.req.header("X-Plugin-Context");
  if (!encoded)
    return c.json(
      {
        error: {
          code: "MISSING_PLUGIN_CONTEXT",
          message: "Internal context required",
        },
      },
      401,
    );
  let context: PluginContext;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    context = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    ) as PluginContext;
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
  if (
    !context.userId ||
    !context.requestId ||
    !Array.isArray(context.permissions)
  )
    return c.json(
      {
        error: {
          code: "INVALID_PLUGIN_CONTEXT",
          message: "Internal context is invalid",
        },
      },
      401,
    );
  const db = await createDatabase(c.env);
  c.set("db", db);
  c.set("pluginContext", context);
  try {
    await next();
  } finally {
    await db.close();
  }
});

app.post("/__installer/smoke", async (c) => {
  const db = c.get("db");
  const id = `maa_smoke_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = db.provider === "d1" ? Date.now() : new Date();
  await db.execute(
    `INSERT INTO meta_ads_accounts(
      id,name,ad_account_id,enabled,created_by_user_id,version,created_at,updated_at
    ) VALUES (?,?,'act_000000',?, ?,1,?,?)`,
    [
      id,
      "Installer smoke",
      db.provider === "d1" ? 0 : false,
      c.get("pluginContext").userId,
      now,
      now,
    ],
  );
  const created = await db.first<{ id: string }>(
    "SELECT id FROM meta_ads_accounts WHERE id = ?",
    [id],
  );
  await db.execute("DELETE FROM meta_ads_accounts WHERE id = ?", [id]);
  return created?.id === id
    ? c.json({ ok: true, read: true, write: true })
    : c.json({ ok: false }, 500);
});

export const metaAdsRoutes = new Hono<MetaAdsEnv>()
  .get("/accounts", async (c) => {
    requirePermission(c, "meta_ads.account.read");
    return c.json({ items: await repository(c).list() });
  })
  .get("/accounts/discover", async (c) => {
    requirePermission(c, "meta_ads.account.read");
    return c.json({ items: await discoverAccounts(c.env) });
  })
  .post("/accounts", async (c) => {
    requirePermission(c, "meta_ads.account.create");
    const parsed = accountInput.parse(await c.req.json());
    const input = {
      ...parsed,
      adAccountId: normalizeAccountId(parsed.adAccountId),
    };
    if (await repository(c).getByAdAccountId(input.adAccountId))
      throw new MetaApiError(
        "AD_ACCOUNT_ALREADY_EXISTS",
        "This ad account is already registered.",
        409,
      );
    const meta = await inspectAccount(c.env, input.adAccountId);
    const context = c.get("pluginContext");
    return c.json(
      await repository(c).create(
        input,
        meta,
        context.userId,
        context.requestId,
      ),
      201,
    );
  })
  .patch("/accounts/:accountId", async (c) => {
    requirePermission(c, "meta_ads.account.update");
    const parsed = accountUpdateInput.parse(await c.req.json());
    const input = {
      ...parsed,
      adAccountId: normalizeAccountId(parsed.adAccountId),
    };
    const duplicate = await repository(c).getByAdAccountId(input.adAccountId);
    if (duplicate && duplicate.id !== c.req.param("accountId"))
      throw new MetaApiError(
        "AD_ACCOUNT_ALREADY_EXISTS",
        "This ad account is already registered.",
        409,
      );
    const meta = await inspectAccount(c.env, input.adAccountId);
    const context = c.get("pluginContext");
    const updated = await repository(c).update(
      c.req.param("accountId"),
      input,
      meta,
      context.userId,
      context.requestId,
    );
    if (!updated)
      throw new MetaApiError(
        "VERSION_CONFLICT",
        "The account changed or no longer exists.",
        409,
      );
    return c.json(updated);
  })
  .delete("/accounts/:accountId", async (c) => {
    requirePermission(c, "meta_ads.account.delete");
    const context = c.get("pluginContext");
    if (
      !(await repository(c).delete(
        c.req.param("accountId"),
        context.userId,
        context.requestId,
      ))
    )
      throw new MetaApiError("NOT_FOUND", "Ad account not found.", 404);
    return c.body(null, 204);
  })
  .post("/accounts/:accountId/test", async (c) => {
    requirePermission(c, "meta_ads.account.read");
    const account = await repository(c).get(c.req.param("accountId"));
    if (!account)
      throw new MetaApiError("NOT_FOUND", "Ad account not found.", 404);
    return c.json({
      ok: true,
      account: await inspectAccount(c.env, account.adAccountId),
    });
  })
  .get("/campaigns", async (c) => {
    requirePermission(c, "meta_ads.campaign.read");
    const accountIds = await assertConfiguredAccounts(
      c,
      parseCsv(c.req.query("accountIds"), 20),
    );
    const rows = await mapWithConcurrency(accountIds, 3, (accountId) =>
      listCampaigns(c.env, accountId, c.req.raw.signal),
    );
    return c.json({ items: rows.flat() });
  })
  .get("/adsets", async (c) => {
    requirePermission(c, "meta_ads.adset.read");
    const accountIds = await assertConfiguredAccounts(
      c,
      parseCsv(c.req.query("accountIds"), 20),
    );
    const campaignIds = parseCsv(c.req.query("campaignIds"), 100);
    await assertConfiguredCampaigns(c, accountIds, campaignIds);
    const rows = await mapWithConcurrency(campaignIds, 3, (campaignId) =>
      listAdSets(c.env, campaignId, c.req.raw.signal),
    );
    return c.json({ items: rows.flat() });
  })
  .get("/ads", async (c) => {
    requirePermission(c, "meta_ads.ad.read");
    const accountIds = await assertConfiguredAccounts(
      c,
      parseCsv(c.req.query("accountIds"), 20),
    );
    const campaignIds = parseCsv(c.req.query("campaignIds"), 100);
    await assertConfiguredCampaigns(c, accountIds, campaignIds);
    const rows = await mapWithConcurrency(campaignIds, 3, (campaignId) =>
      listAds(c.env, campaignId, c.req.raw.signal),
    );
    return c.json({ items: rows.flat() });
  })
  .get("/insights", async (c) => {
    requirePermission(c, "meta_ads.insight.read");
    const accountIds = await assertConfiguredAccounts(
      c,
      parseCsv(c.req.query("accountIds"), 20),
    );
    const adIds = parseCsv(c.req.query("adIds"), 500);
    const since = c.req.query("since") || "";
    const until = c.req.query("until") || "";
    return c.json({
      items: await insightItems(c, accountIds, adIds, since, until),
    });
  })
  .post("/insights/query", async (c) => {
    requirePermission(c, "meta_ads.insight.read");
    const input = insightQueryInput.parse(await c.req.json());
    const accountIds = await assertConfiguredAccounts(c, input.accountIds);
    return c.json({
      items: await insightItems(
        c,
        accountIds,
        [...new Set(input.adIds)],
        input.since,
        input.until,
      ),
    });
  })
  .post("/status", async (c) => {
    const input = statusInput.parse(await c.req.json());
    requirePermission(c, `meta_ads.${input.objectType}.update`);
    const configured = await repository(c).enabledAccountIds();
    const objectAccountId = await getObjectAccountId(c.env, input.objectId);
    if (!configured.has(objectAccountId))
      throw new MetaApiError(
        "AD_ACCOUNT_NOT_CONFIGURED",
        "This object does not belong to an enabled ad account.",
        403,
      );
    await setObjectStatus(c.env, input.objectId, input.status);
    const context = c.get("pluginContext");
    await repository(c).auditStatusChange(
      input.objectId,
      input.objectType,
      input.status,
      context.userId,
      context.requestId,
    );
    return c.json({ ok: true });
  });

app.route("/", metaAdsRoutes);
app.onError((error, c) => {
  if (error instanceof MetaApiError)
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.status as 400 | 401 | 403 | 404 | 409 | 500 | 502 | 503,
    );
  if (error instanceof z.ZodError)
    return c.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Review the submitted values.",
        },
      },
      400,
    );
  return c.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "Unexpected plugin error.",
      },
    },
    500,
  );
});

export type MetaAdsAppType = typeof metaAdsRoutes;
export default app;
