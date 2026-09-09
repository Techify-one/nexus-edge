import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { parsePluginArchive } from "../workers/core/src/installer/package-v2.js";

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
const legacyArtifacts = generatedArtifacts.filter((file) => {
  const files = unzipSync(readFileSync(file));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]!)) as {
    packageFormat?: number;
  };
  return manifest.packageFormat !== 2;
});
const v2Artifacts = generatedArtifacts.filter(
  (file) => !legacyArtifacts.includes(file),
);
for (const file of v2Artifacts) await parsePluginArchive(readFileSync(file));

const trackedLegacyArtifacts = execFileSync(
  "git",
  ["ls-files", "--", `${pluginsDirectory}/*/release/*.plugin.zip`],
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .sort();

if (legacyArtifacts.some((file) => !trackedLegacyArtifacts.includes(file))) {
  throw new Error(
    [
      "A legacy bridge artifact is not tracked.",
      `Legacy: ${legacyArtifacts.join(", ") || "none"}`,
      `Tracked: ${trackedLegacyArtifacts.join(", ") || "none"}`,
      "Format 2 artifacts belong in a marketplace release, not in the Core repository.",
    ].join("\n"),
  );
}

if (legacyArtifacts.length) {
  const comparison = spawnSync(
    "git",
    ["diff", "--exit-code", "--", ...legacyArtifacts],
    { stdio: "inherit" },
  );
  if (comparison.error) throw comparison.error;
  if (comparison.status !== 0)
    throw new Error(
      "Generated plugin artifacts differ from their staged versions. Rebuild and stage them.",
    );
}

process.stdout.write(
  `Verified ${legacyArtifacts.length} legacy bridge artifact(s) and ${v2Artifacts.length} format 2 artifact(s).\n`,
);
