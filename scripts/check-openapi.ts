import { OPENAPI_DOCUMENT } from "../workers/core/src/lib/openapi.js";

const required = [
  "/api/v1/me",
  "/api/v1/users",
  "/api/v1/groups",
  "/api/v1/p/crm/leads",
  "/api/v1/p/soletrando/children",
  "/api/v1/p/soletrando/settings/transcription",
  "/api/v1/public/p/soletrando/play/{token}",
  "/api/v1/webhooks/endpoints",
  "/api/v1/plugin-operations",
  "/api/v1/plugin-operations/{operationId}/provision-r2",
  "/api/v1/p/meeting_recorder/recordings",
  "/api/v1/p/meeting_recorder/recordings/{recordingId}/reconcile",
  "/api/v1/p/meeting_recorder/recordings/{recordingId}/segments/{sequence}",
  "/api/v1/p/meeting_recorder/recordings/{recordingId}/segments/{sequence}/audio",
  "/api/v1/p/meeting_recorder/recordings/{recordingId}/segments/{sequence}/transcribe",
  "/api/v1/p/meeting_recorder/recordings/{recordingId}/deletion-steps",
  "/api/v1/plugins/meeting_recorder/runtime-secrets/{secretName}",
  "/api/v1/p/meeting_recorder/telegram/link-requests",
  "/api/v1/public/p/meeting_recorder/telegram/webhook",
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
