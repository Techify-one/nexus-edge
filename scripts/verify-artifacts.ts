import { existsSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

const pluginsDirectory = "plugins";
const generatedArtifacts = readdirSync(pluginsDirectory, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) =>
    join(pluginsDirectory, entry.name, "release", `${entry.name}.plugin.zip`),
  )
  .filter(existsSync)
  .sort();
const trackedArtifacts = execFileSync(
  "git",
  ["ls-files", "--", `${pluginsDirectory}/*/release/*.plugin.zip`],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .sort();

if (
  generatedArtifacts.length !== trackedArtifacts.length ||
  generatedArtifacts.some((file, index) => file !== trackedArtifacts[index])
) {
  throw new Error(
    [
      "Generated and tracked plugin artifact lists differ.",
      `Generated: ${generatedArtifacts.join(", ") || "none"}`,
      `Tracked: ${trackedArtifacts.join(", ") || "none"}`,
      "Stage every generated plugins/*/release/*.plugin.zip file before verification.",
    ].join("\n"),
  );
}

const comparison = spawnSync(
  "git",
  ["diff", "--exit-code", "--", ...generatedArtifacts],
  { stdio: "inherit" },
);
if (comparison.error) throw comparison.error;
if (comparison.status !== 0)
  throw new Error(
    "Generated plugin artifacts differ from their staged versions. Rebuild and stage them.",
  );

process.stdout.write(
  `Verified ${generatedArtifacts.length} tracked plugin artifacts.\n`,
);
