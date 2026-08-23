import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
});
