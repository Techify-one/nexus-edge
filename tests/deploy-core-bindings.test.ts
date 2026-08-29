import { describe, expect, it } from "vitest";
import { bindingsForServiceRestore } from "../scripts/cloudflare-bindings.js";

describe("Core dynamic binding restoration", () => {
  it("inherits every existing binding and writes only services explicitly", () => {
    const bindings = bindingsForServiceRestore(
      [
        { type: "assets", name: "ASSETS" },
        { type: "secret_text", name: "BETTER_AUTH_SECRET" },
        { type: "d1", name: "DB", id: "database-id" },
        {
          type: "service",
          name: "PLUGIN_MEETING_RECORDER",
          service: "old-worker",
          environment: "production",
        },
      ],
      [
        {
          type: "service",
          name: "PLUGIN_MEETING_RECORDER",
          service: "scoped-meeting-recorder",
          environment: "production",
        },
      ],
    );

    expect(bindings).toEqual([
      { type: "inherit", name: "ASSETS" },
      { type: "inherit", name: "BETTER_AUTH_SECRET" },
      { type: "inherit", name: "DB" },
      {
        type: "service",
        name: "PLUGIN_MEETING_RECORDER",
        service: "scoped-meeting-recorder",
      },
    ]);
    expect(JSON.stringify(bindings)).not.toContain("database-id");
    expect(JSON.stringify(bindings)).not.toContain("secret_text");
  });

  it("rejects a service snapshot without a writable target", () => {
    expect(() =>
      bindingsForServiceRestore(
        [],
        [{ type: "service", name: "PLUGIN_BROKEN" }],
      ),
    ).toThrow("PLUGIN_BROKEN");
  });
});
