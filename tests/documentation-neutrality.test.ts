import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const markdownFiles = (): string[] =>
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((path) => /\.mdx?$/iu.test(path) && existsSync(path));

describe("tool-neutral documentation", () => {
  it("uses the open instruction entry point", () => {
    const filenames = markdownFiles().map((path) => path.toLowerCase());
    expect(filenames).toContain("agents.md");
    expect(filenames).not.toContain("deploy-codex.md");
  });

  it("keeps compatibility adapters import-only", () => {
    expect(readFileSync("CLAUDE.md", "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(".agents/rules/project.md", "utf8")).toBe(
      "@../../AGENTS.md\n",
    );
  });

  it("does not reference coding-assistant vendors", () => {
    const forbidden = /\b(codex|claude|antigravity|cursor|copilot|gemini)\b/iu;
    const violations = markdownFiles().filter((path) =>
      forbidden.test(readFileSync(path, "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
