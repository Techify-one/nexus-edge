import { resolve } from "node:path";
import { basename, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gzipSync, strToU8, zipSync } from "fflate";
import { buildPluginPackage } from "@nexus/plugin-sdk/package";

const id = process.argv[2];
if (!id || !/^[a-z][a-z0-9_]{1,31}$/u.test(id))
  throw new Error("Use: tsx scripts/package-plugin.ts <plugin-id>");
const root = resolve("plugins", id);
const manifestSource = readFileSync(join(root, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestSource) as { packageFormat?: number };
let output: string;
if (manifest.packageFormat === 2) {
  const privateKey = process.env.PLUGIN_SIGNING_PRIVATE_KEY?.trim();
  if (!privateKey)
    throw new Error(
      "PLUGIN_SIGNING_PRIVATE_KEY is required for package format 2.",
    );
  output = await buildPluginPackage({
    root,
    privateKey,
    keyId: process.env.PLUGIN_SIGNING_KEY_ID?.trim() || "publisher-v1",
  });
} else {
  const worker = readFileSync(join(root, "dist", "index.js"));
  if (gzipSync(worker).byteLength > 3 * 1024 * 1024)
    throw new Error("The compressed Worker exceeds 3 MiB.");
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(manifestSource),
    "worker.mjs": worker,
  };
  for (const dialect of ["d1", "postgres"] as const)
    for (const file of readdirSync(join(root, "migrations", dialect))
      .filter((name) => name.endsWith(".sql"))
      .sort())
      files[`migrations/${dialect}/${basename(file)}`] = readFileSync(
        join(root, "migrations", dialect, file),
      );
  const releaseDirectory = join(root, "release");
  mkdirSync(releaseDirectory, { recursive: true });
  output = join(releaseDirectory, `${id}.plugin.zip`);
  writeFileSync(
    output,
    zipSync(files, {
      level: 9,
      mtime: new Date(2000, 0, 1, 0, 0, 0),
      os: 3,
      attrs: 0o644 << 16,
    }),
  );
}
process.stdout.write(`${output}\n`);
