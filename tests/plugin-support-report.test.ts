import { describe, expect, it } from "vitest";
import { buildPluginSupportReport } from "../frontend/src/features/plugins/support-report.js";

describe("plugin Installer support report", () => {
  it("builds a deterministic copyable report from safe diagnostics", () => {
    const report = buildPluginSupportReport({
      diagnostic: {
        operationId: "pop_diagnostic",
        pluginId: "crm",
        targetVersion: "1.0.0",
        type: "install",
        state: "failed",
        failureStage: "deploying",
        failureReason: "cloudflare_api_400_10021",
        failureDetail: "Cloudflare API returned HTTP 400 with code(s) 10021.",
        failureRequestId: "req_server",
        failedAt: Date.parse("2026-08-22T19:39:45.000Z"),
      },
      package: {
        pluginId: "crm",
        version: "1.0.0",
        rawBytes: 4096,
        gzipBytes: 1024,
        d1MigrationIds: ["0001_init"],
        postgresMigrationIds: ["0001_init"],
      },
      clientErrorCode: "PLUGIN_OPERATION_FAILED",
      clientRequestId: "req_client",
      coreOrigin: "https://core.example.test",
      generatedAt: Date.parse("2026-08-22T19:40:00.000Z"),
    });

    expect(report).toContain("Operation ID: pop_diagnostic");
    expect(report).toContain("Failure stage: deploying");
    expect(report).toContain("Failure code: cloudflare_api_400_10021");
    expect(report).toContain("Failure request ID: req_server");
    expect(report).toContain("Client request ID: req_client");
    expect(report).toContain("D1 migrations: 0001_init");
    expect(report).toContain(
      "raw provider logs, package contents, credentials, and secrets were omitted",
    );
  });

  it("uses safe placeholders when no server operation was created", () => {
    const report = buildPluginSupportReport({
      diagnostic: {},
      package: {
        pluginId: "crm",
        version: "1.0.0",
        rawBytes: 10,
        gzipBytes: 5,
        d1MigrationIds: [],
        postgresMigrationIds: [],
      },
      clientErrorCode: "PLUGIN_MANIFEST_INVALID",
      coreOrigin: "https://core.example.test",
      generatedAt: 0,
    });

    expect(report).toContain("Operation ID: not-created");
    expect(report).toContain("Failure stage: validating");
    expect(report).toContain("Failure code: PLUGIN_MANIFEST_INVALID");
    expect(report).toContain("D1 migrations: none");
  });

  it("keeps untrusted package metadata on a single bounded line", () => {
    const report = buildPluginSupportReport({
      diagnostic: {},
      package: {
        pluginId: "crm\nForged field: secret",
        version: "1.0.0\tmodified",
        rawBytes: 10,
        gzipBytes: 5,
        d1MigrationIds: ["0001_init\nToken: hidden"],
        postgresMigrationIds: [],
      },
      coreOrigin: "https://core.example.test",
      generatedAt: 0,
    });

    expect(report).toContain("Plugin ID: crm Forged field: secret");
    expect(report).not.toContain("\nForged field:");
    expect(report).not.toContain("\nToken:");
  });
});
