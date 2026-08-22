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
  it("uses the open instruction entry point without vendor-specific files", () => {
    const filenames = markdownFiles().map((path) => path.toLowerCase());
    expect(filenames).toContain("agents.md");
    expect(filenames).not.toContain("claude.md");
    expect(filenames).not.toContain("deploy-codex.md");
  });

  it("does not reference coding-assistant vendors", () => {
    const forbidden = /\b(codex|claude|antigravity|cursor|copilot|gemini)\b/iu;
    const violations = markdownFiles().filter((path) =>
      forbidden.test(readFileSync(path, "utf8")),
    );
    expect(violations).toEqual([]);
  });
});
