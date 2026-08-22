import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginManifestSchema } from "../workers/core/src/installer/manifest.js";
import { mapWithConcurrency } from "../workers/plugin-meta_ads/src/index.js";
import {
  discoverAccounts,
  extractMetaPurchases,
  normalizeAccountId,
  validateDateRange,
} from "../workers/plugin-meta_ads/src/meta-client.js";

afterEach(() => vi.unstubAllGlobals());

describe("Meta Ads plugin", () => {
  it("ships an Installer-compatible manifest without account-specific values", () => {
    const source = readFileSync(
      "workers/plugin-meta_ads/manifest.json",
      "utf8",
    );
    const manifest = pluginManifestSchema.parse(JSON.parse(source));

    expect(manifest.id).toBe("meta_ads");
    expect(manifest.menu.map((item) => item.routeKey)).toEqual([
      "meta_ads.dashboard",
      "meta_ads.accounts",
    ]);
    expect(source).not.toContain("act_");
  });

  it("normalizes and validates ad account identifiers", () => {
    expect(normalizeAccountId("123456789")).toBe("act_123456789");
    expect(normalizeAccountId(" act_987654321 ")).toBe("act_987654321");
    expect(() => normalizeAccountId("business-one")).toThrow(
      "act_123456 format",
    );
  });

  it("uses a bearer token and removes tokens from pagination URLs", async () => {
    const urls: string[] = [];
    const authorizations: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        authorizations.push(
          new Headers(init?.headers).get("Authorization") || "",
        );
        if (urls.length === 1)
          return new Response(
            JSON.stringify({
              data: [{ id: "act_123456", name: "Primary" }],
              paging: {
                next: "https://graph.facebook.com/v25.0/me/adaccounts?after=cursor&access_token=must-not-leak",
              },
            }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({ data: [{ account_id: "987654", name: "Second" }] }),
          { status: 200 },
        );
      }),
    );

    const accounts = await discoverAccounts({
      DATABASE_PROVIDER: "d1",
      META_ACCESS_TOKEN: "private-token",
      META_API_VERSION: "v25.0",
    });

    expect(accounts.map((account) => account.id)).toEqual([
      "act_123456",
      "act_987654",
    ]);
    expect(urls.every((url) => !url.includes("access_token"))).toBe(true);
    expect(authorizations).toEqual([
      "Bearer private-token",
      "Bearer private-token",
    ]);
  });

  it("derives purchases with the same precedence as the existing dashboard", () => {
    expect(
      extractMetaPurchases([
        { action_type: "omni_purchase", value: "9" },
        { action_type: "offsite_conversion.fb_pixel_purchase", value: "4" },
        { action_type: "purchase", value: "2" },
      ]),
    ).toBe(2);
    expect(extractMetaPurchases(undefined)).toBe(0);
  });

  it("surfaces Meta ad-account throttling as a rate-limit error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: 80004,
              error_subcode: 2446079,
              message: "Too many calls",
            },
          },
          { status: 400 },
        ),
      ),
    );

    await expect(
      discoverAccounts({
        DATABASE_PROVIDER: "d1",
        META_ACCESS_TOKEN: "private-token",
        META_API_VERSION: "v25.0",
      }),
    ).rejects.toMatchObject({ code: "META_RATE_LIMITED", status: 429 });
  });

  it("accepts bounded date ranges and rejects invalid ranges", () => {
    expect(() => validateDateRange("2026-08-01", "2026-08-22")).not.toThrow();
    expect(() => validateDateRange("2026-08-22", "2026-08-01")).toThrow(
      "invalid",
    );
    expect(() => validateDateRange("2024-01-01", "2026-08-22")).toThrow("366");
  });

  it("bounds Meta fan-out instead of opening one request per campaign", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      3,
      async (value) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return value * 2;
      },
    );

    expect(maximum).toBeLessThanOrEqual(3);
    expect(result).toEqual(Array.from({ length: 12 }, (_, index) => index * 2));
  });

  it("preserves private Worker secrets across plugin updates", () => {
    const source = readFileSync(
      "workers/core/src/installer/cloudflare.ts",
      "utf8",
    );
    expect(source).toContain('keep_bindings: ["secret_text", "secret_key"]');
  });

  it("keeps the dashboard controls compact and the critical actions visible", () => {
    const dashboard = readFileSync(
      "frontend/src/plugins/meta_ads/MetaAdsDashboardPage.tsx",
      "utf8",
    );
    const table = readFileSync(
      "frontend/src/components/ui/configurable-data-table.tsx",
      "utf8",
    );
    const shell = readFileSync(
      "frontend/src/components/layout/AppShell.tsx",
      "utf8",
    );

    expect(dashboard).toContain(
      "xl:grid-cols-[0.8fr_1.15fr_1.05fr_1.2fr_0.75fr]",
    );
    expect(dashboard).toContain('role="switch"');
    expect(dashboard).toContain(
      "relative inline-flex h-6 w-11 shrink-0 items-center",
    );
    expect(dashboard).toContain("absolute left-0.5 top-0.5 h-5 w-5");
    expect(dashboard).toContain("metaAds.hideTestData");
    expect(dashboard).toContain("setSearchParams(params, { replace: true })");
    expect(dashboard).toContain('method: "POST"');
    expect(dashboard).toContain("pagedInsightRows");
    expect(dashboard).toContain("setCreativePreview");
    expect(table).toContain("sticky right-0");
    expect(table).toContain('title={t("table.columns")}');
    expect(shell).toContain("nexus.sidebar.hidden");
    expect(shell).toContain('startsWith("/app/meta-ads")');
  });

  it("manages the Meta token only through private Worker secrets", () => {
    const accountsPage = readFileSync(
      "frontend/src/plugins/meta_ads/MetaAdsAccountsPage.tsx",
      "utf8",
    );
    const cloudflare = readFileSync(
      "workers/core/src/installer/cloudflare.ts",
      "utf8",
    );

    expect(accountsPage).toContain("META_ACCESS_TOKEN");
    expect(accountsPage).toContain("recentReauthHeaders");
    expect(cloudflare).toContain("putPluginSecret");
    expect(cloudflare).toContain("deletePluginSecret");
    expect(cloudflare).not.toContain("return value");
  });
});
