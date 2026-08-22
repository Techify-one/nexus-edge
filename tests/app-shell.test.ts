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
    expect(shell).toContain('className="hidden px-2 lg:inline-flex"');
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
});
