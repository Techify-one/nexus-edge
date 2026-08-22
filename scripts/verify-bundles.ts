import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "fflate";

const pluginBundles = [
  "workers/plugin-crm/dist/index.js",
  "workers/plugin-template/dist/index.js",
];
const unsupportedDynamicRequires = [
  "crypto",
  "dns",
  "events",
  "fs",
  "net",
  "path",
  "stream",
  "string_decoder",
  "tls",
  "util",
  "util/types",
];
for (const bundlePath of pluginBundles) {
  if (!existsSync(bundlePath))
    throw new Error(`${bundlePath} is missing. Run pnpm build.`);
  const bundle = readFileSync(bundlePath, "utf8");
  const unsupported = unsupportedDynamicRequires.filter((moduleName) =>
    bundle.includes(`__require("${moduleName}")`),
  );
  if (unsupported.length)
    throw new Error(
      `${bundlePath} contains unsupported dynamic Node.js requires: ${unsupported.join(", ")}`,
    );
}
const workerBytes = gzipSync(readFileSync(pluginBundles[0]!)).byteLength;
if (workerBytes > 3 * 1024 * 1024)
  throw new Error(`CRM gzip exceeds 3 MiB: ${workerBytes}`);
process.stdout.write(
  `CRM worker gzip: ${(workerBytes / 1024).toFixed(1)} KiB (3072 KiB limit).\n`,
);
