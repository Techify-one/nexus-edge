import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolvePluginBackTarget } from "../frontend/src/plugins/navigation.js";

describe("application shell", () => {
  it("can completely hide the sidebar throughout the authenticated app", () => {
    const shell = readFileSync(
      "frontend/src/components/layout/AppShell.tsx",
      "utf8",
    );

    expect(shell).toContain(
      'window.localStorage.getItem("nexus.sidebar.hidden")',
    );
    expect(shell).toContain(
      'sidebarHidden ? "w-0 border-r-0" : "w-60 border-r"',
    );
    expect(shell).toContain('sidebarHidden ? "lg:pl-0" : "lg:pl-60"');
    expect(shell).toContain("fixed top-1/2 z-40 hidden h-7 w-7");
    expect(shell).toContain("-translate-x-1/2 -translate-y-1/2");
    expect(shell).toContain('sidebarHidden ? "left-3.5" : "left-60"');
    expect(shell).toContain('<ChevronLeft className="h-4 w-4" aria-hidden />');
    expect(shell).toContain('<ChevronRight className="h-4 w-4" aria-hidden />');
    expect(shell).not.toContain("PanelLeftClose");
    expect(shell).not.toContain("PanelLeftOpen");
    expect(shell).not.toContain('sidebarCollapsed ? "w-20"');
  });

  it("keeps plugin destinations out of the Core sidebar", () => {
    const shell = readFileSync(
      "frontend/src/components/layout/AppShell.tsx",
      "utf8",
    );

    expect(shell).not.toContain("plugin-navigation");
    expect(shell).not.toContain("routeKey:");
    expect(shell).not.toMatch(/permission:\s*"(?!core\.)/u);
  });

  it("does not expose the current route path in the header", () => {
    const shell = readFileSync(
      "frontend/src/components/layout/AppShell.tsx",
      "utf8",
    );

    expect(shell).not.toContain("{location.pathname}");
  });

  it("shows a hierarchical Core-owned back button on registered plugin routes", () => {
    const shell = readFileSync(
      "frontend/src/components/layout/AppShell.tsx",
      "utf8",
    );
    const guide = readFileSync("docs/PLUGIN-DEVELOPMENT.md", "utf8");
    const template = readFileSync("plugins/template/README.md", "utf8");

    expect(shell).toContain(
      'import { pluginRoutePaths } from "../../plugins/registry.js"',
    );
    expect(shell).toContain(
      'import { resolvePluginBackTarget } from "../../plugins/navigation.js"',
    );
    expect(shell).toContain(
      "const pluginBackTarget = resolvePluginBackTarget(",
    );
    expect(shell).toContain("Object.values(pluginRoutePaths)");
    expect(shell).toContain("onClick={() => navigate(pluginBackTarget)}");
    expect(shell).toContain('aria-label={t("common.back")}');
    expect(guide).toContain("Core-owned **Back** button");
    expect(template).toContain("Core header supplies a **Back** button");
  });

  it("returns from nested plugin routes to the plugin overview", () => {
    const routes = [
      "/app/meeting-recorder",
      "/app/meeting-recorder/settings",
      "/app/meeting-recorder/:recordingId",
      "/app/crm/leads/:leadId",
    ];

    expect(
      resolvePluginBackTarget("/app/meeting-recorder/settings", routes),
    ).toBe("/app/meeting-recorder");
    expect(
      resolvePluginBackTarget("/app/meeting-recorder/mrr_123", routes),
    ).toBe("/app/meeting-recorder");
    expect(resolvePluginBackTarget("/app/crm/leads/crm_123", routes)).toBe(
      "/app/crm",
    );
    expect(resolvePluginBackTarget("/app/meeting-recorder/", routes)).toBe(
      "/app",
    );
    expect(resolvePluginBackTarget("/app/users", routes)).toBeUndefined();
  });
});
