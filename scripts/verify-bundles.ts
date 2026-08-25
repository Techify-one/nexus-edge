import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "fflate";

const workerBundles = [
  "plugins/crm/dist/index.js",
  "plugins/meta_ads/dist/index.js",
  "plugins/soletrando/dist/index.js",
  "plugins/template/dist/index.js",
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
for (const bundlePath of workerBundles) {
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
for (const bundlePath of workerBundles.filter(
  (path) => !path.includes("/template/"),
)) {
  const workerBytes = gzipSync(readFileSync(bundlePath)).byteLength;
  if (workerBytes > 3 * 1024 * 1024)
    throw new Error(`${bundlePath} gzip exceeds 3 MiB: ${workerBytes}`);
  process.stdout.write(
    `${bundlePath} gzip: ${(workerBytes / 1024).toFixed(1)} KiB (3072 KiB limit).\n`,
  );
}
