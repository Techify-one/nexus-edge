import { describe, expect, it } from "vitest";
import {
  parsePermission,
  redactUrl,
} from "../packages/core-contract/src/index.js";
import {
  signWebhook,
  stableJson,
} from "../packages/webhook-contract/src/index.js";
import {
  firstAdminSchema,
  invitationAcceptSchema,
  listQuerySchema,
  tablePreferenceConfigSchema,
  tablePreferenceIdSchema,
  userCreateSchema,
  userUpdateSchema,
} from "../packages/api-contracts/src/index.js";
import { CORE_PERMISSIONS } from "../packages/db-schema/src/common/index.js";
import { isPermissionAvailable } from "../workers/core/src/services/permissions.js";
import { countProfileOptions } from "../workers/core/src/lib/values.js";

describe("contracts", () => {
  it("converts permissions into action/subject", () =>
    expect(parsePermission("crm.lead.read")).toEqual({
      action: "read",
      subject: "crm.lead",
    }));
  it("redacts sensitive URLs", () =>
    expect(redactUrl("https://hooks.example.com/a/secret")).toBe(
      "https://hooks.example.com/…",
    ));
  it("stabilizes JSON", () =>
    expect(stableJson({ z: 1, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":1}',
    ));
  it("signs webhooks deterministically", async () =>
    expect(await signWebhook("secret", "evt_1", 123, "{}")).toMatch(
      /^v1=[A-Za-z0-9_-]{43}$/u,
    ));
  it("normalizes empty searches so records remain visible", () => {
    expect(listQuerySchema.parse({ search: "" }).search).toBeUndefined();
    expect(listQuerySchema.parse({ search: "  " }).search).toBeUndefined();
  });
  it("validates bounded personal table preferences", () => {
    const preference = {
      version: 1 as const,
      columnOrder: ["name", "email", "status"],
      columnVisibility: { name: true, email: false, status: true },
      columnSizing: { name: 240, email: 320, status: 140 },
      sorting: [{ id: "name", desc: false }],
    };
    expect(tablePreferenceIdSchema.parse("core.users")).toBe("core.users");
    expect(tablePreferenceConfigSchema.parse(preference)).toEqual(preference);
    expect(tablePreferenceIdSchema.safeParse("../users").success).toBe(false);
    expect(
      tablePreferenceConfigSchema.safeParse({
        ...preference,
        columnSizing: { name: 10 },
      }).success,
    ).toBe(false);
  });
  it("creates the first administrator without a token and with an 8-character password", () => {
    const result = firstAdminSchema.parse({
      name: "Admin",
      email: "ADMIN@example.com",
      password: "12345678",
    });
    expect(result).toEqual({
      name: "Admin",
      email: "admin@example.com",
      password: "12345678",
    });
    expect(
      firstAdminSchema.safeParse({ ...result, password: "1234567" }).success,
    ).toBe(false);
  });
  it("accepts invitation passwords with at least 8 characters", () => {
    expect(
      invitationAcceptSchema.safeParse({
        token: "x".repeat(32),
        name: "User",
        password: "12345678",
      }).success,
    ).toBe(true);
  });
  it("validates every field required to create a user", () => {
    expect(
      userCreateSchema.parse({
        name: "  New User  ",
        email: "NEW@example.com",
        password: "12345678",
        active: false,
        groupIds: ["grp_team"],
      }),
    ).toEqual({
      name: "New User",
      email: "new@example.com",
      password: "12345678",
      active: false,
      groupIds: ["grp_team"],
    });
    expect(
      userCreateSchema.safeParse({
        name: "New User",
        email: "new@example.com",
        password: "1234567",
      }).success,
    ).toBe(false);
  });
  it("validates complete user edits and keeps an empty password unchanged", () => {
    expect(
      userUpdateSchema.parse({
        name: "  Updated User  ",
        email: "UPDATED@example.com",
        password: "",
        active: true,
        groupIds: ["grp_team"],
      }),
    ).toEqual({
      name: "Updated User",
      email: "updated@example.com",
      password: undefined,
      active: true,
      groupIds: ["grp_team"],
    });
    expect(userUpdateSchema.safeParse({ password: "1234567" }).success).toBe(
      false,
    );
    expect(userUpdateSchema.safeParse({}).success).toBe(false);
  });
  it("validates user profile fields and a complete weekly schedule", () => {
    const profile = {
      phone: "64993467452",
      telegramId: "6690214875",
      jobTitle: "Desenvolvedor",
      birthDate: "2003-10-04",
      cpf: "71148138137",
      tags: ["PJ"],
      sectors: ["DEV"],
      notes: "Observação interna",
      status: "pending" as const,
      schedule: {
        dailyHours: [
          "08:00",
          "08:00",
          "08:00",
          "08:00",
          "08:00",
          "00:00",
          "00:00",
        ],
        entryTimes: ["08:30", "", "", "", "", "", ""],
      },
    };
    expect(userUpdateSchema.parse(profile)).toEqual(profile);
    expect(userUpdateSchema.safeParse({ ...profile, cpf: "123" }).success).toBe(
      false,
    );
    expect(
      userUpdateSchema.safeParse({
        ...profile,
        schedule: { ...profile.schedule, dailyHours: ["08:00"] },
      }).success,
    ).toBe(false);
  });
  it("collects reusable profile options and counts each user once", () => {
    expect(
      countProfileOptions([
        '["PJ","CLT","pj"]',
        '["pj","DEV"]',
        "invalid-json",
      ]),
    ).toEqual([
      { value: "PJ", usageCount: 2 },
      { value: "CLT", usageCount: 1 },
      { value: "DEV", usageCount: 1 },
    ]);
  });
  it("seeds only Core permissions before plugins are installed", () => {
    expect(CORE_PERMISSIONS.every((key) => key.startsWith("core."))).toBe(true);
    expect(CORE_PERMISSIONS).not.toContain("crm.lead.read");
    expect(CORE_PERMISSIONS).toEqual([
      "core.user.read",
      "core.user.create",
      "core.user.update",
      "core.user.delete",
      "core.group.read",
      "core.group.create",
      "core.group.update",
      "core.group.delete",
      "core.plugin.read",
      "core.plugin.create",
      "core.plugin.update",
      "core.plugin.delete",
      "core.webhook.read",
      "core.webhook.create",
      "core.webhook.update",
      "core.webhook.delete",
      "core.webhook.test",
      "core.webhook.redeliver",
      "core.audit.read",
    ]);
  });
  it("exposes plugin permissions only while the plugin is installed", () => {
    expect(isPermissionAvailable("core.group.read", new Set())).toBe(true);
    expect(isPermissionAvailable("crm.lead.read", new Set())).toBe(false);
    expect(isPermissionAvailable("crm.lead.read", new Set(["crm"]))).toBe(true);
  });
});
