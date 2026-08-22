import { createMongoAbility } from "@casl/ability";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import type { HonoEnv } from "../workers/core/src/env.js";
import { managementRoutes } from "../workers/core/src/routes/management.js";

describe("plugin Overview navigation", () => {
  it("returns one searchable record per installed plugin permitted to the user", async () => {
    const database = {
      provider: "d1",
      orm: {},
      query: async (sql: string) => {
        if (sql.includes("FROM plugins"))
          return [
            {
              id: "crm",
              name: "CRM",
              manifest: JSON.stringify({
                menu: [
                  { title: "CRM", routeKey: "crm.home" },
                  { title: "Leads", routeKey: "crm.leads" },
                ],
              }),
            },
            {
              id: "meta_ads",
              name: "Meta Ads",
              manifest: JSON.stringify({
                menu: [
                  {
                    title: "Meta Ads",
                    routeKey: "meta_ads.dashboard",
                  },
                ],
              }),
            },
            {
              id: "inventory",
              name: "Inventory",
              manifest: JSON.stringify({
                menu: [{ title: "Inventory", routeKey: "inventory.home" }],
              }),
            },
          ];
        return [
          { key: "crm.lead.read" },
          { key: "meta_ads.insight.read" },
          { key: "inventory.item.read" },
        ];
      },
      first: async () => null,
      execute: async () => ({ rowsAffected: 0 }),
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;
    const app = new Hono<HonoEnv>();
    app.use("*", async (context, next) => {
      context.set("db", database);
      context.set(
        "ability",
        createMongoAbility<[string, string]>([
          { action: "read", subject: "crm.lead" },
          { action: "read", subject: "meta_ads.insight" },
        ]),
      );
      await next();
    });
    app.route("/", managementRoutes);

    const response = await app.request("/me/plugin-navigation");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      plugins: [
        {
          pluginId: "crm",
          name: "CRM",
          menu: [
            { title: "CRM", routeKey: "crm.home" },
            { title: "Leads", routeKey: "crm.leads" },
          ],
        },
        {
          pluginId: "meta_ads",
          name: "Meta Ads",
          menu: [{ title: "Meta Ads", routeKey: "meta_ads.dashboard" }],
        },
      ],
      items: [
        { pluginId: "crm", title: "CRM", routeKey: "crm.home" },
        { pluginId: "crm", title: "Leads", routeKey: "crm.leads" },
        {
          pluginId: "meta_ads",
          title: "Meta Ads",
          routeKey: "meta_ads.dashboard",
        },
      ],
    });
  });
});
