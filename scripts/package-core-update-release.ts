import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { zipSync } from "fflate";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as { version: string };
const version = process.env.INSTALLER_RELEASE_VERSION ?? packageJson.version;
const releaseRoot = resolve(
  process.env.INSTALLER_RELEASE_OUTPUT ??
    join(repositoryRoot, "installer/release-build"),
);
const versionRoot = join(releaseRoot, "releases", version);
const outputRoot = resolve(
  process.env.CORE_UPDATE_OUTPUT ??
    join(repositoryRoot, "artifacts/core-update"),
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
  return output.toSorted();
}

const manifest = await readFile(join(versionRoot, "release.json"));
const signature = await readFile(join(versionRoot, "release.sig"));
const archiveEntries: Record<string, Uint8Array> = {};
for (const path of await files(versionRoot)) {
  const localPath = relative(releaseRoot, path).replaceAll("\\", "/");
  if (localPath.endsWith("/release.json") || localPath.endsWith("/release.sig"))
    continue;
  archiveEntries[localPath] = await readFile(path);
}
if (!Object.keys(archiveEntries).length)
  throw new Error("Core update archive has no signed objects");

await mkdir(outputRoot, { recursive: true });
await Promise.all([
  writeFile(join(outputRoot, "nexus-edge-release.json"), manifest),
  writeFile(join(outputRoot, "nexus-edge-release.sig"), signature),
  writeFile(
    join(outputRoot, "nexus-edge-update.zip"),
    zipSync(archiveEntries, {
      level: 9,
      mtime: new Date(2000, 0, 1, 0, 0, 0),
      os: 3,
      attrs: 0o644 << 16,
    }),
  ),
]);
const archiveSize = (await stat(join(outputRoot, "nexus-edge-update.zip")))
  .size;
if (archiveSize > 20 * 1024 * 1024)
  throw new Error("Core update archive exceeds the runtime download limit");
process.stdout.write(
  `${JSON.stringify({ version, outputRoot, objects: Object.keys(archiveEntries).length, archiveSize })}\n`,
);
