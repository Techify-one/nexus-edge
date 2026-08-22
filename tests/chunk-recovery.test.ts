import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldReloadChunk } from "../frontend/src/lib/chunk-recovery.js";

describe("frontend deployment recovery", () => {
  it("reloads an obsolete lazy chunk once per recovery window", () => {
    expect(shouldReloadChunk(0, 100_000)).toBe(true);
    expect(shouldReloadChunk(90_000, 100_000)).toBe(false);
    expect(shouldReloadChunk(60_000, 100_001)).toBe(true);
  });

  it("keeps Meta Ads account management out of the primary navigation", () => {
    const shell = readFileSync(
      "frontend/src/components/layout/AppShell.tsx",
      "utf8",
    );
    const dashboard = readFileSync(
      "frontend/src/plugins/meta_ads/MetaAdsDashboardPage.tsx",
      "utf8",
    );

    expect(shell).not.toContain('to: "/app/meta-ads/accounts"');
    expect(shell).not.toContain('to: "/app/meta-ads"');
    expect(shell).not.toContain('to: "/app/crm/leads"');
    expect(shell).not.toContain('queryKey: ["me", "plugin-navigation"]');
    expect(dashboard).toContain('navigate("/app/meta-ads/accounts")');
    expect(dashboard).toContain("metaAds.accounts.manage");
  });
});
