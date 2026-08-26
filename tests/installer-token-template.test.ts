import { describe, expect, it } from "vitest";
import { cloudflareAccountTokensUrl } from "../frontend/src/lib/cloudflare-token.js";

describe("plugin runtime token link", () => {
  it("opens the token page for the selected Cloudflare account", () => {
    const accountId = "a".repeat(32);
    const url = new URL(cloudflareAccountTokensUrl(accountId));

    expect(url.origin).toBe("https://dash.cloudflare.com");
    expect(url.pathname).toBe(`/${accountId}/api-tokens`);
    expect(url.search).toBe("");
  });
});
