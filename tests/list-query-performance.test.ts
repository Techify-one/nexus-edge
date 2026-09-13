import { createMongoAbility } from "@casl/ability";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { DatabasePort } from "../packages/database/src/index.js";
import type { HonoEnv } from "../workers/core/src/env.js";
import { managementRoutes } from "../workers/core/src/routes/management.js";

const appWithDatabase = (database: DatabasePort) => {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("db", database);
    c.set(
      "ability",
      createMongoAbility<[string, string]>([
        { action: "manage", subject: "all" },
      ]),
    );
    await next();
  });
  app.route("/", managementRoutes);
  return app;
};

describe("record list query budgets", () => {
  it("loads users and their memberships in one database query", async () => {
    const query = vi.fn(async () => [
      {
        id: "usr_one",
        name: "One",
        email: "one@example.com",
        active: 1,
        createdAt: 10,
        tagsJson: "[]",
        sectorsJson: "[]",
        dailyHoursJson: null,
        groupId: "grp_admin",
        groupName: "Administrators",
      },
      {
        id: "usr_one",
        name: "One",
        email: "one@example.com",
        active: 1,
        createdAt: 10,
        tagsJson: "[]",
        sectorsJson: "[]",
        dailyHoursJson: null,
        groupId: "grp_sales",
        groupName: "Sales",
      },
    ]);
    const database = {
      provider: "d1",
      orm: {},
      query,
      first: async () => null,
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;

    const response = await appWithDatabase(database).request(
      "/users?limit=100&search=",
    );

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      items: [
        {
          id: "usr_one",
          groups: [
            { id: "grp_admin", name: "Administrators" },
            { id: "grp_sales", name: "Sales" },
          ],
        },
      ],
    });
  });

  it("loads groups, counts, and available permission keys in one query", async () => {
    const query = vi.fn(async () => [
      {
        id: "grp_admin",
        name: "Administrators",
        isAdmin: 1,
        createdAt: 10,
        memberCount: 2,
        permissionKey: "core.user.read",
      },
      {
        id: "grp_admin",
        name: "Administrators",
        isAdmin: 1,
        createdAt: 10,
        memberCount: 2,
        permissionKey: "core.user.update",
      },
    ]);
    const database = {
      provider: "d1",
      orm: {},
      query,
      first: async () => null,
      execute: async () => ({ rowsAffected: 1 }),
      atomic: async () => [],
      close: async () => undefined,
    } as DatabasePort;

    const response = await appWithDatabase(database).request("/groups");

    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({
      items: [
        {
          id: "grp_admin",
          memberCount: 2,
          permissionKeys: ["core.user.read", "core.user.update"],
        },
      ],
    });
  });
});
