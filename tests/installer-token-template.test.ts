import { describe, expect, it } from "vitest";
import {
  cloudflareAccountTokensUrl,
  cloudflarePluginTokenTemplateUrl,
  cloudflareR2TokenTemplateUrl,
  cloudflareUserTokensUrl,
} from "../frontend/src/lib/cloudflare-token.js";

describe("plugin runtime token link", () => {
  it("opens the token page for the selected Cloudflare account", () => {
    const accountId = "a".repeat(32);
    const url = new URL(cloudflareAccountTokensUrl(accountId));

    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe(`/${accountId}/api-tokens`);
    expect(url.search).toBe("");
  });

  it("prefills a least-privilege account token for Nexus plugins", () => {
    const accountId = "b".repeat(32);
    const url = new URL(cloudflarePluginTokenTemplateUrl(accountId));

    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("to")).toBe(`/${accountId}/api-tokens`);
    expect(
      JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]"),
    ).toEqual([{ key: "workers_scripts", type: "edit" }]);
    expect(url.searchParams.get("name")).toBe("Nexus Edge Plugins");
  });

  it("opens the user API token page for temporary R2 provisioning", () => {
    const url = new URL(cloudflareUserTokensUrl());

    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
    expect(url.search).toBe("");
  });

  it("prefills the modern least-privilege R2 token route", () => {
    const accountId = "c".repeat(32);
    const url = new URL(cloudflareR2TokenTemplateUrl(accountId));

    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe("/profile/api-tokens");
    expect(url.searchParams.get("accountId")).toBe(accountId);
    expect(url.searchParams.get("zoneId")).toBe("all");
    expect(
      JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]"),
    ).toEqual([{ key: "workers_r2", type: "edit" }]);
    expect(url.searchParams.get("name")).toBe("Nexus Edge Plugin R2");
  });
});
