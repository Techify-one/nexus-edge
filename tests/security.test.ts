import { describe, expect, it } from "vitest";
import { validateWebhookUrl } from "../workers/core/src/webhooks/ssrf.js";
import { validateDatabaseBindings } from "../packages/database/src/index.js";

describe("security gates", () => {
  it.each([
    "http://example.com/hook",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://10.0.0.1/hook",
    "https://example.com:8443/hook",
    "https://example.com/hook?q=secret",
  ])("rejects webhook %s", (url) =>
    expect(() => validateWebhookUrl(url)).toThrow(),
  );
  it("accepts public HTTPS and allowlisted domains", () =>
    expect(
      validateWebhookUrl("https://hooks.example.com/event", "example.com")
        .hostname,
    ).toBe("hooks.example.com"));
  it("does not silently fall back to another provider", () => {
    expect(() =>
      validateDatabaseBindings({ DATABASE_PROVIDER: "sqlite" } as never),
    ).toThrow();
    expect(() =>
      validateDatabaseBindings({ DATABASE_PROVIDER: "d1" }),
    ).toThrow();
    expect(() =>
      validateDatabaseBindings({
        DATABASE_PROVIDER: "postgres",
        DB: {} as D1Database,
        DATABASE_URL: "postgres://local",
      }),
    ).toThrow();
  });
});
