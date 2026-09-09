import { OPENAPI_DOCUMENT } from "../workers/core/src/lib/openapi.js";

const required = [
  "/api/v1/me",
  "/api/v1/users",
  "/api/v1/groups",
  "/api/v1/p/{pluginId}/{path}",
  "/api/v1/public/p/{pluginId}/{path}",
  "/api/v1/public/plugin-runtime",
  "/api/v1/webhooks/endpoints",
  "/api/v1/plugin-operations",
  "/api/v1/plugin-operations/{operationId}/provision-r2",
  "/api/v1/plugin-platform",
  "/api/v1/plugin-runtime",
  "/api/v1/plugin-marketplaces",
  "/api/v1/plugin-marketplaces/{marketplaceId}/sync",
  "/api/v1/plugin-catalog",
  "/api/v1/plugin-catalog/{releaseId}/package",
  "/api/v1/plugin-operations/{operationId}/resources/{logicalName}/provision",
  "/api/v1/plugins/{pluginId}/runtime-resources/{logicalName}/provision",
  "/api/v1/plugins/{pluginId}/runtime-secrets/{secretName}",
  "/api/v1/audit",
];
for (const path of required)
  if (!(path in OPENAPI_DOCUMENT.paths))
    throw new Error(`OpenAPI is missing ${path}`);
if (OPENAPI_DOCUMENT.openapi !== "3.1.0")
  throw new Error("The specification must use OpenAPI 3.1.0.");
process.stdout.write(
  `Valid OpenAPI: ${Object.keys(OPENAPI_DOCUMENT.paths).length} documented paths.\n`,
);
