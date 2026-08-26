import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stableReleasePointerSchema } from "@app/installer-release-schema";

const repositoryRoot = resolve(import.meta.dirname, "..");
const releaseRoot = resolve(
  process.env.INSTALLER_RELEASE_OUTPUT ??
    join(repositoryRoot, "installer/release-build"),
);
const bucket = process.env.INSTALLER_RELEASE_BUCKET;
if (!bucket) throw new Error("INSTALLER_RELEASE_BUCKET is required");
const mode = process.env.INSTALLER_RELEASE_PUBLISH_MODE ?? "all";
if (
  !(["objects", "promote", "all"] as const).includes(
    mode as "objects" | "promote" | "all",
  )
)
  throw new Error(
    "INSTALLER_RELEASE_PUBLISH_MODE must be objects, promote, or all",
  );

async function files(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await visit(root);
  return output.sort();
}

const pointerPath = join(releaseRoot, "releases/stable.json");
stableReleasePointerSchema.parse(
  JSON.parse(await readFile(pointerPath, "utf8")),
);
const immutableObjects = (await files(releaseRoot)).filter(
  (path) => path !== pointerPath,
);
const objects =
  mode === "objects"
    ? immutableObjects
    : mode === "promote"
      ? [pointerPath]
      : [...immutableObjects, pointerPath];

for (const path of objects) {
  const key = relative(releaseRoot, path).replaceAll("\\", "/");
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      "--remote",
      "--file",
      path,
      "--force",
    ],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`R2 upload failed for ${key}`);
}

process.stdout.write(
  `${JSON.stringify({ success: true, bucket, mode, objects: objects.length })}\n`,
);
