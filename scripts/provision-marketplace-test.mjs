import { readFileSync, writeFileSync } from "node:fs";

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !/^[a-f0-9]{32}$/u.test(accountId ?? ""))
  throw new Error("Cloudflare deployment credentials are unavailable.");

const origin = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const request = async (path, init = {}) => {
  const response = await fetch(`${origin}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const body = await response.json();
  if (!response.ok || !body.success)
    throw new Error(
      `Cloudflare API ${response.status}: ${
        body.errors?.map((error) => error.code ?? error.message).join(",") ??
        "unknown"
      }`,
    );
  return body.result;
};

const databaseName = "nexus-edge-marketplace-test-db";
const databases = await request("/d1/database?per_page=100");
let database = databases.find((candidate) => candidate.name === databaseName);
if (!database)
  database = await request("/d1/database", {
    method: "POST",
    body: JSON.stringify({ name: databaseName }),
  });
const databaseId = database.uuid ?? database.id;
if (!/^[a-f0-9-]{36}$/u.test(databaseId ?? ""))
  throw new Error("Cloudflare returned an invalid D1 database ID.");

const queues = await request("/queues?page=1&per_page=100");
for (const name of [
  "nexus-edge-marketplace-test-webhooks",
  "nexus-edge-marketplace-test-webhooks-dlq",
]) {
  if (queues.some((candidate) => candidate.queue_name === name)) continue;
  await request("/queues", {
    method: "POST",
    body: JSON.stringify({ queue_name: name }),
  });
}

const configPath = "workers/core/wrangler.marketplace-test.jsonc";
const config = readFileSync(configPath, "utf8");
const rendered = config.replaceAll(
  "00000000-0000-0000-0000-000000000000",
  databaseId,
);
if (
  rendered === config ||
  rendered.includes("00000000-0000-0000-0000-000000000000")
)
  throw new Error("The marketplace-test Wrangler template was not rendered.");
writeFileSync(configPath, rendered);
process.stdout.write("Marketplace test Cloudflare resources are ready.\n");
