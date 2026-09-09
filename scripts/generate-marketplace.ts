import { resolve } from "node:path";
import { generatePluginMarketplace } from "@nexus/plugin-sdk/marketplace";

const privateKey = process.env.PLUGIN_SIGNING_PRIVATE_KEY?.trim();
if (!privateKey) throw new Error("PLUGIN_SIGNING_PRIVATE_KEY is required.");
const result = generatePluginMarketplace({
  pluginsDirectory: resolve(
    process.env.MARKETPLACE_PLUGINS_DIRECTORY?.trim() || "plugins",
  ),
  output: resolve(
    process.env.MARKETPLACE_OUTPUT?.trim() || "nexus-marketplace.json",
  ),
  repository:
    process.env.MARKETPLACE_GITHUB_REPOSITORY?.trim() ||
    "Techify-one/nexus-edge-plugins",
  marketplaceName: process.env.MARKETPLACE_NAME?.trim() || "Techify",
  publisherId: process.env.MARKETPLACE_PUBLISHER_ID?.trim() || "techify",
  publisherName: process.env.MARKETPLACE_PUBLISHER_NAME?.trim() || "Techify",
  keyId: process.env.PLUGIN_SIGNING_KEY_ID?.trim() || "publisher-v1",
  privateKey,
});
process.stdout.write(
  `Generated marketplace revision ${result.revision} with ${result.pluginCount} plugin(s).\n`,
);
