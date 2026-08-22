import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "fflate";

const candidates = ["workers/plugin-crm/dist/index.js", "frontend/dist/assets"];
if (!existsSync(candidates[0]!))
  throw new Error("CRM bundle is missing. Run pnpm build:plugins.");
const workerBytes = gzipSync(readFileSync(candidates[0]!)).byteLength;
if (workerBytes > 3 * 1024 * 1024)
  throw new Error(`CRM gzip exceeds 3 MiB: ${workerBytes}`);
process.stdout.write(
  `CRM worker gzip: ${(workerBytes / 1024).toFixed(1)} KiB (3072 KiB limit).\n`,
);
