import { readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const artifactDirectory = "artifacts";
const generatedArtifacts = readdirSync(artifactDirectory)
  .filter((file) => file.endsWith(".plugin.zip"))
  .map((file) => `${artifactDirectory}/${file}`)
  .sort();
const trackedArtifacts = execFileSync(
  "git",
  ["ls-files", "--", `${artifactDirectory}/*.plugin.zip`],
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
      "Stage every generated artifacts/*.plugin.zip file before verification.",
    ].join("\n"),
  );
}

const comparison = spawnSync(
  "git",
  ["diff", "--exit-code", "--", artifactDirectory],
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
