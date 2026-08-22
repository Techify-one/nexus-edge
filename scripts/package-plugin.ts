import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";

const id = process.argv[2];
if (!id || !/^[a-z][a-z0-9_]{1,31}$/u.test(id))
  throw new Error("Use: tsx scripts/package-plugin.ts <plugin-id>");
const root = `workers/plugin-${id}`;
const workerPath = join(root, "dist", "index.js");
const worker = readFileSync(workerPath);
if (gzipSync(worker).byteLength > 3 * 1024 * 1024)
  throw new Error("The gzip bundle exceeds 3 MiB.");
const files: Record<string, Uint8Array> = {
  "manifest.json": strToU8(readFileSync(join(root, "manifest.json"), "utf8")),
  "worker.mjs": worker,
};
for (const dialect of ["d1", "postgres"]) {
  for (const file of readdirSync(join(root, "migrations", dialect))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    files[`migrations/${dialect}/${basename(file)}`] = strToU8(
      readFileSync(join(root, "migrations", dialect, file), "utf8"),
    );
  }
}
mkdirSync("artifacts", { recursive: true });
const output = `artifacts/${id}.plugin.zip`;
writeFileSync(output, zipSync(files, { level: 9 }));
process.stdout.write(`${output}\n`);
