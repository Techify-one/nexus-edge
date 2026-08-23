/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SingleLineFilterBar } from "../frontend/src/components/ui/index.js";

afterEach(cleanup);

describe("plugin filter layout standard", () => {
  it("keeps every filter in one shared non-wrapping row", () => {
    render(
      <SingleLineFilterBar aria-label="Filters">
        <div>Account</div>
        <div>Campaign</div>
        <div>Ad set</div>
        <div>Ad</div>
        <div>Period</div>
      </SingleLineFilterBar>,
    );

    const row = screen.getByLabelText("Filters").firstElementChild;
    expect(row?.className).toContain("flex-nowrap");
    expect(row?.className).toContain("[&>*]:min-w-0");
    expect(row?.className).toContain("[&>*]:flex-1");
    expect(row?.className).not.toContain("flex-wrap");
  });

  it("documents the shared component for future plugin screens", () => {
    const guide = readFileSync("docs/PLUGIN-DEVELOPMENT.md", "utf8");

    expect(guide).toContain("### Filter layout standard");
    expect(guide).toContain("shared `SingleLineFilterBar`");
    expect(guide).toContain("non-wrapping row");
  });
});
