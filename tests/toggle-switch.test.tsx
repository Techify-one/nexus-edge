/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ToggleSwitch } from "../frontend/src/components/ui/index.js";

afterEach(cleanup);

describe("status switch", () => {
  it("renders a semantic track and thumb for both states", () => {
    const { rerender } = render(
      <ToggleSwitch checked={false} aria-label="Creative status" />,
    );

    const toggle = screen.getByRole("switch", { name: "Creative status" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.className).toContain("app-switch");
    expect(toggle.firstElementChild?.className).toContain("app-switch-thumb");

    rerender(<ToggleSwitch checked aria-label="Creative status" />);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("defines visible track, thumb, active, and dark-mode styles", () => {
    const css = readFileSync("frontend/src/styles/globals.css", "utf8");

    expect(css).toContain(".app-switch {");
    expect(css).toContain('.app-switch[aria-checked="true"]');
    expect(css).toContain('.app-switch[data-checked="true"]');
    expect(css).toContain(".app-switch-thumb {");
    expect(css).toContain("html.dark .app-switch");
  });
});
