import { OPENAPI_DOCUMENT } from "../workers/core/src/lib/openapi.js";

const required = [
  "/api/v1/me",
  "/api/v1/users",
  "/api/v1/groups",
  "/api/v1/p/crm/leads",
  "/api/v1/webhooks/endpoints",
  "/api/v1/plugin-operations",
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
