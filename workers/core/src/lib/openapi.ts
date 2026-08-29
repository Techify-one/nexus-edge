export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Nexus Edge API",
    version: "1.0.0",
    description:
      "API-first administration, private plugin gateways, webhooks and plugin installation.",
  },
  servers: [{ url: "/" }],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
      },
      bearerAuth: { type: "http", scheme: "bearer" },
      apiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message", "requestId"],
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              requestId: { type: "string" },
            },
          },
        },
      },
      UserUpdate: {
        type: "object",
        minProperties: 1,
        properties: {
          name: { type: "string", minLength: 2, maxLength: 120 },
          email: { type: "string", format: "email" },
          password: {
            type: "string",
            minLength: 8,
            maxLength: 200,
            description:
              "Optional new password. Omit it to keep the current password.",
          },
          active: { type: "boolean" },
          status: {
            type: "string",
            enum: ["active", "inactive", "pending"],
          },
          phone: { type: "string", maxLength: 40 },
          telegramId: { type: "string", maxLength: 64 },
          jobTitle: { type: "string", maxLength: 120 },
          birthDate: { type: "string", format: "date" },
          cpf: { type: "string", pattern: "^[0-9]{11}$" },
          tags: { type: "array", maxItems: 50, items: { type: "string" } },
          sectors: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
          },
          notes: { type: "string", maxLength: 5000 },
          schedule: { $ref: "#/components/schemas/WeekSchedule" },
          groupIds: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
          },
        },
      },
      UserCreate: {
        type: "object",
        required: ["name", "email", "password", "active", "groupIds"],
        properties: {
          name: { type: "string", minLength: 2, maxLength: 120 },
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8, maxLength: 200 },
          active: { type: "boolean", default: true },
          status: {
            type: "string",
            enum: ["active", "inactive", "pending"],
          },
          phone: { type: "string", maxLength: 40 },
          telegramId: { type: "string", maxLength: 64 },
          jobTitle: { type: "string", maxLength: 120 },
          birthDate: { type: "string", format: "date" },
          cpf: { type: "string", pattern: "^[0-9]{11}$" },
          tags: { type: "array", maxItems: 50, items: { type: "string" } },
          sectors: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
          },
          notes: { type: "string", maxLength: 5000 },
          schedule: { $ref: "#/components/schemas/WeekSchedule" },
          groupIds: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            default: [],
          },
        },
      },
      WeekSchedule: {
        type: "object",
        required: ["dailyHours", "entryTimes"],
        properties: {
          dailyHours: {
            type: "array",
            minItems: 7,
            maxItems: 7,
            items: {
              type: "string",
              pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
            },
          },
          entryTimes: {
            type: "array",
            minItems: 7,
            maxItems: 7,
            items: { type: "string" },
          },
        },
      },
      TablePreferenceConfig: {
        type: "object",
        additionalProperties: false,
        required: [
          "version",
          "columnOrder",
          "columnVisibility",
          "columnSizing",
          "sorting",
        ],
        properties: {
          version: { type: "integer", const: 1 },
          columnOrder: {
            type: "array",
            maxItems: 64,
            items: { type: "string" },
          },
          columnVisibility: {
            type: "object",
            additionalProperties: { type: "boolean" },
          },
          columnSizing: {
            type: "object",
            additionalProperties: {
              type: "integer",
              minimum: 48,
              maximum: 2000,
            },
          },
          sorting: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              required: ["id", "desc"],
              properties: {
                id: { type: "string" },
                desc: { type: "boolean" },
              },
            },
          },
        },
      },
      OverviewPreferenceConfig: {
        type: "object",
        additionalProperties: false,
        required: ["version", "itemOrder"],
        properties: {
          version: { type: "integer", const: 1 },
          itemOrder: {
            type: "array",
            maxItems: 128,
            uniqueItems: true,
            items: {
              type: "string",
              minLength: 3,
              maxLength: 96,
              pattern: "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$",
            },
          },
        },
      },
    },
  },
  security: [{ cookieAuth: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }],
  paths: {
    "/api/auth/sign-in/email": {
      post: {
        summary:
          "Login with e-mail and password; Bearer plugin returns set-auth-token",
        security: [],
        responses: { "200": { description: "Authenticated" } },
      },
    },
    "/api/v1/setup/status": {
      get: {
        security: [],
        responses: { "200": { description: "Bootstrap state" } },
      },
    },
    "/api/v1/setup/first-admin": {
      post: {
        security: [],
        responses: { "201": { description: "First administrator created" } },
      },
    },
    "/api/v1/invitations/accept": {
      post: {
        security: [],
        responses: { "201": { description: "Invitation accepted" } },
      },
    },
    "/api/v1/me": {
      get: { responses: { "200": { description: "Current principal" } } },
    },
    "/api/v1/me/ability": {
      get: { responses: { "200": { description: "Packed CASL rules" } } },
    },
    "/api/v1/me/permissions": {
      get: {
        responses: {
          "200": { description: "Concrete permissions available for API keys" },
        },
      },
    },
    "/api/v1/me/table-preferences/{tableId}": {
      get: {
        parameters: [{ name: "tableId", in: "path", required: true }],
        responses: { "200": { description: "Personal table preference" } },
      },
      put: {
        parameters: [{ name: "tableId", in: "path", required: true }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TablePreferenceConfig" },
            },
          },
        },
        responses: { "200": { description: "Preference saved" } },
      },
      delete: {
        parameters: [{ name: "tableId", in: "path", required: true }],
        responses: { "204": { description: "Preference reset" } },
      },
    },
    "/api/v1/me/overview-preference": {
      get: {
        responses: { "200": { description: "Personal overview order" } },
      },
      put: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OverviewPreferenceConfig" },
            },
          },
        },
        responses: { "200": { description: "Overview order saved" } },
      },
    },
    "/api/v1/me/api-keys": {
      get: { responses: { "200": { description: "Personal keys" } } },
      post: {
        responses: { "201": { description: "Secret returned once" } },
      },
    },
    "/api/v1/users": {
      get: { responses: { "200": { description: "Users" } } },
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserCreate" },
            },
          },
        },
        responses: { "201": { description: "User created" } },
      },
    },
    "/api/v1/users/profile-options": {
      get: {
        responses: {
          "200": {
            description: "Reusable user tags and sectors with usage counts",
          },
        },
      },
    },
    "/api/v1/users/{userId}": {
      patch: {
        parameters: [
          { name: "userId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: false },
          {
            name: "X-Reauth-Token",
            in: "header",
            required: false,
            description: "Required only when changing the password.",
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/UserUpdate" },
            },
          },
        },
        responses: { "200": { description: "User updated" } },
      },
      delete: {
        parameters: [
          { name: "userId", in: "path", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        responses: { "204": { description: "User access removed" } },
      },
    },
    "/api/v1/users/{userId}/schedule-history": {
      get: {
        parameters: [{ name: "userId", in: "path", required: true }],
        responses: {
          "200": { description: "Effective work schedule history" },
        },
      },
    },
    "/api/v1/invitations": {
      get: { responses: { "200": { description: "Invitations" } } },
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: { "201": { description: "Invitation and one-time link" } },
      },
    },
    "/api/v1/groups": {
      get: { responses: { "200": { description: "Groups" } } },
      post: { responses: { "201": { description: "Group created" } } },
    },
    "/api/v1/p/crm/leads": {
      get: { responses: { "200": { description: "Leads" } } },
      post: { responses: { "201": { description: "Lead created" } } },
    },
    "/api/v1/p/soletrando/children": {
      post: {
        responses: {
          "201": { description: "Child and practice link created" },
        },
      },
    },
    "/api/v1/p/soletrando/settings/transcription": {
      get: {
        responses: {
          "200": { description: "Active transcription model" },
        },
      },
      put: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: {
          "200": { description: "Transcription model updated" },
        },
      },
    },
    "/api/v1/p/soletrando/children/{childId}": {
      get: {
        parameters: [{ name: "childId", in: "path", required: true }],
        responses: { "200": { description: "Child practice history" } },
      },
      patch: {
        parameters: [{ name: "childId", in: "path", required: true }],
        responses: { "200": { description: "Child updated" } },
      },
      delete: {
        parameters: [{ name: "childId", in: "path", required: true }],
        responses: { "204": { description: "Child history deleted" } },
      },
    },
    "/api/v1/public/p/soletrando/play/{token}": {
      get: {
        security: [],
        parameters: [{ name: "token", in: "path", required: true }],
        responses: {
          "200": { description: "Public spelling practice profile" },
        },
      },
    },
    "/api/v1/public/p/soletrando/play/{token}/sessions": {
      post: {
        security: [],
        parameters: [{ name: "token", in: "path", required: true }],
        responses: { "201": { description: "Practice session started" } },
      },
    },
    "/api/v1/public/p/soletrando/play/{token}/attempts": {
      post: {
        security: [],
        parameters: [{ name: "token", in: "path", required: true }],
        responses: {
          "200": { description: "Audio transcribed and attempt evaluated" },
        },
      },
    },
    "/api/v1/p/meta_ads/accounts": {
      get: {
        responses: { "200": { description: "Configured Meta ad accounts" } },
      },
      post: {
        responses: {
          "201": { description: "Meta ad account verified and created" },
        },
      },
    },
    "/api/v1/p/meta_ads/campaigns": {
      get: {
        responses: {
          "200": { description: "Meta campaigns for configured accounts" },
        },
      },
    },
    "/api/v1/p/meta_ads/adsets": {
      get: {
        responses: {
          "200": { description: "Meta ad sets for configured campaigns" },
        },
      },
    },
    "/api/v1/p/meta_ads/ads": {
      get: {
        responses: {
          "200": { description: "Meta ads for configured campaigns" },
        },
      },
    },
    "/api/v1/p/meta_ads/insights": {
      get: {
        responses: { "200": { description: "Meta ad performance insights" } },
      },
    },
    "/api/v1/p/meta_ads/insights/query": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["accountIds", "adIds", "since", "until"],
                properties: {
                  accountIds: { type: "array", items: { type: "string" } },
                  adIds: { type: "array", items: { type: "string" } },
                  since: { type: "string", format: "date" },
                  until: { type: "string", format: "date" },
                  allTime: {
                    type: "boolean",
                    description:
                      "Use Meta's maximum date preset instead of the explicit date range.",
                  },
                  hideTestData: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Batched Meta ad performance insights" },
        },
      },
    },
    "/api/v1/plugins/meta_ads/runtime-secrets/META_ACCESS_TOKEN": {
      get: {
        responses: {
          "200": { description: "Meta token configuration status" },
        },
      },
      put: {
        responses: { "200": { description: "Meta token configured" } },
      },
      delete: {
        responses: { "204": { description: "Meta token deleted" } },
      },
    },
    "/api/v1/p/meta_ads/status": {
      post: {
        responses: { "200": { description: "Meta object status updated" } },
      },
    },
    "/api/v1/webhooks/endpoints": {
      get: { responses: { "200": { description: "Redacted endpoints" } } },
      post: {
        responses: {
          "201": { description: "Endpoint and secret returned once" },
        },
      },
    },
    "/api/v1/webhooks/deliveries": {
      get: { responses: { "200": { description: "Delivery history" } } },
    },
    "/api/v1/plugins": {
      get: { responses: { "200": { description: "Plugin registry records" } } },
    },
    "/api/v1/plugin-runtime-credential": {
      get: {
        responses: {
          "200": {
            description:
              "Secret-free Cloudflare plugin credential status and selected account ID",
          },
          "503": { description: "Cloudflare account target is unavailable" },
        },
      },
      put: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: {
                    type: "string",
                    minLength: 40,
                    maxLength: 2048,
                    writeOnly: true,
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Credential validated and stored directly as a Core Worker secret",
          },
          "422": {
            description:
              "Credential is invalid, belongs to another account, or is broader than Workers Scripts Edit",
          },
          "503": { description: "Cloudflare could not store the secret" },
        },
      },
    },
    "/api/v1/plugins/{pluginId}": {
      delete: {
        parameters: [{ name: "pluginId", in: "path", required: true }],
        responses: {
          "204": {
            description:
              "Installed plugin uninstalled, or uninstalled registry record deleted",
          },
          "404": { description: "Plugin record not found" },
          "409": { description: "Plugin is in a transitional state" },
        },
      },
    },
    "/api/v1/plugins/{pluginId}/package": {
      get: {
        parameters: [{ name: "pluginId", in: "path", required: true }],
        responses: {
          "200": {
            description:
              "Portable plugin ZIP containing code, manifest, and schema-only migrations",
            content: {
              "application/zip": {
                schema: { type: "string", format: "binary" },
              },
            },
          },
          "403": { description: "Plugin export permission required" },
          "404": { description: "Plugin not found" },
          "409": {
            description:
              "Plugin is not installed or its portable package is unavailable",
          },
        },
      },
      post: {
        parameters: [{ name: "pluginId", in: "path", required: true }],
        requestBody: {
          description:
            "Exact original package used to restore export availability for a legacy installation; no deployment or migration is performed",
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: {
          "204": { description: "Portable package archive restored" },
          "403": { description: "Plugin export permission required" },
          "404": { description: "Plugin not found" },
          "409": {
            description:
              "Plugin is not installed or package ID, version, or hashes do not match the installed artifact",
          },
          "422": { description: "Plugin package is invalid or unsafe" },
        },
      },
    },
    "/api/v1/plugin-operations": {
      get: { responses: { "200": { description: "Installer operations" } } },
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        requestBody: {
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "Operation created" } },
      },
    },
    "/api/v1/plugin-operations/{operationId}": {
      get: {
        parameters: [{ name: "operationId", in: "path", required: true }],
        responses: {
          "200": {
            description:
              "Installer operation with allowlisted, secret-free failure diagnostics",
          },
          "404": { description: "Installer operation not found" },
        },
      },
    },
    "/api/v1/plugin-operations/{operationId}/provision-r2": {
      post: {
        parameters: [
          { name: "operationId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: {
                    type: "string",
                    minLength: 40,
                    maxLength: 2048,
                    writeOnly: true,
                  },
                  mode: { type: "string", enum: ["create", "attach"] },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Dedicated R2 bucket provisioned and attached",
          },
          "403": {
            description: "Recent reauthentication or R2 permission required",
          },
          "409": { description: "Operation is not in the provisioning state" },
          "422": {
            description: "Temporary R2 token is invalid or over-privileged",
          },
        },
      },
    },
    "/api/v1/plugins/{pluginId}/runtime-resources/r2": {
      post: {
        parameters: [
          { name: "pluginId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["token"],
                properties: {
                  token: {
                    type: "string",
                    minLength: 40,
                    maxLength: 2048,
                    writeOnly: true,
                  },
                  mode: { type: "string", enum: ["create", "attach"] },
                  bucketName: { type: "string", minLength: 3, maxLength: 63 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Optional private R2 bucket provisioned and attached to an installed plugin",
          },
          "403": {
            description:
              "Plugin update permission and recent reauthentication required",
          },
          "409": {
            description:
              "Plugin does not support optional R2, installer is busy, or R2 is unavailable",
          },
          "422": {
            description: "Temporary R2 token is invalid or over-privileged",
          },
        },
      },
    },
    "/api/v1/p/meeting_recorder/recordings": {
      get: {
        parameters: [
          { name: "cursor", in: "query", required: false },
          { name: "sort", in: "query", required: false },
          { name: "direction", in: "query", required: false },
        ],
        responses: { "200": { description: "Authorized recording page" } },
      },
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: { "201": { description: "Live recording created" } },
      },
    },
    "/api/v1/p/meeting_recorder/imports": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: { "201": { description: "Audio import reserved" } },
      },
    },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}/reconcile": {
      post: {
        parameters: [
          { name: "recordingId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: true },
        ],
        responses: {
          "200": { description: "Up to 25 pending segment objects reconciled" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}/segments/{sequence}": {
      put: {
        parameters: [
          { name: "recordingId", in: "path", required: true },
          { name: "sequence", in: "path", required: true },
          { name: "X-Segment-SHA256", in: "header", required: true },
          { name: "X-Segment-Bytes", in: "header", required: true },
          { name: "X-Segment-Duration-Ms", in: "header", required: true },
          { name: "X-Segment-Start-Ms", in: "header", required: true },
          { name: "X-Client-Session-Id", in: "header", required: true },
        ],
        requestBody: {
          required: true,
          content: {
            "audio/webm": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          "200": { description: "Idempotent replay" },
          "201": { description: "Segment streamed to private R2 storage" },
        },
      },
      head: {
        parameters: [
          { name: "recordingId", in: "path", required: true },
          { name: "sequence", in: "path", required: true },
        ],
        responses: { "200": { description: "Stored segment metadata" } },
      },
    },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}/segments/{sequence}/audio":
      {
        get: {
          parameters: [
            { name: "recordingId", in: "path", required: true },
            { name: "sequence", in: "path", required: true },
            { name: "Range", in: "header", required: false },
          ],
          responses: {
            "200": { description: "Private audio segment" },
            "206": { description: "Private audio byte range" },
          },
        },
      },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}/segments/{sequence}/transcribe":
      {
        post: {
          parameters: [
            { name: "recordingId", in: "path", required: true },
            { name: "sequence", in: "path", required: true },
            { name: "Idempotency-Key", in: "header", required: true },
          ],
          responses: {
            "200": { description: "Segment transcribed with Workers AI" },
          },
        },
      },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}/transcript": {
      get: {
        parameters: [{ name: "recordingId", in: "path", required: true }],
        responses: {
          "200": { description: "Transcript as JSON, plain text, or WebVTT" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}": {
      get: {
        parameters: [{ name: "recordingId", in: "path", required: true }],
        responses: { "200": { description: "Recording details" } },
      },
      delete: {
        parameters: [
          { name: "recordingId", in: "path", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        responses: { "202": { description: "Resumable deletion started" } },
      },
    },
    "/api/v1/p/meeting_recorder/recordings/{recordingId}/deletion-steps": {
      post: {
        parameters: [
          { name: "recordingId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: true },
        ],
        responses: {
          "202": { description: "Up to 500 private audio objects deleted" },
          "204": { description: "Recording deletion completed" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/settings": {
      get: {
        responses: {
          "200": { description: "Recorder and Telegram secret status" },
        },
      },
      put: {
        responses: { "200": { description: "Recorder defaults updated" } },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/configure": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: {
          "200": {
            description:
              "Bot identity validated and canonical Telegram webhook verified or corrected",
          },
          "503": { description: "Telegram Worker secrets are not active" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/validate": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: {
          "200": { description: "Telegram bot token and identity validated" },
          "422": { description: "Token does not identify a valid bot" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/link-requests": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: {
          "201": {
            description:
              "Short-lived personal Telegram deep link created for the authenticated user",
          },
          "503": { description: "Telegram bot or webhook is not configured" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/access": {
      get: {
        responses: {
          "200": {
            description:
              "Active Telegram members and pending invitations visible to the authenticated user",
          },
          "403": { description: "Telegram member read permission required" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/invitations": {
      post: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: {
          "201": {
            description:
              "One-time Telegram member invitation created; the raw link is returned only once",
          },
          "403": {
            description:
              "Telegram member invitation and recording creation permissions required",
          },
          "503": { description: "Telegram bot or webhook is not configured" },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/invitations/{invitationId}": {
      delete: {
        parameters: [
          { name: "invitationId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: true },
        ],
        responses: {
          "204": { description: "Pending Telegram invitation revoked" },
          "404": {
            description: "Invitation not found in the permitted owner scope",
          },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/members/{memberId}": {
      delete: {
        parameters: [
          { name: "memberId", in: "path", required: true },
          { name: "Idempotency-Key", in: "header", required: true },
        ],
        responses: {
          "204": {
            description:
              "Telegram member access revoked while prior recordings remain preserved",
          },
          "404": {
            description: "Member not found in the permitted owner scope",
          },
        },
      },
    },
    "/api/v1/p/meeting_recorder/telegram/configuration": {
      delete: {
        parameters: [{ name: "Idempotency-Key", in: "header", required: true }],
        responses: {
          "204": {
            description:
              "Telegram webhook removed and public bot metadata cleared",
          },
        },
      },
    },
    "/api/v1/plugins/meeting_recorder/runtime-secrets/{secretName}": {
      get: {
        parameters: [{ name: "secretName", in: "path", required: true }],
        responses: {
          "200": { description: "Secret configuration status only" },
        },
      },
      put: {
        parameters: [
          { name: "secretName", in: "path", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        responses: {
          "200": { description: "Telegram Worker secret configured" },
        },
      },
      delete: {
        parameters: [
          { name: "secretName", in: "path", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        responses: { "204": { description: "Telegram Worker secret deleted" } },
      },
    },
    "/api/v1/public/p/meeting_recorder/telegram/webhook": {
      post: {
        security: [],
        responses: {
          "200": {
            description: "Telegram update accepted or ignored idempotently",
          },
          "403": { description: "Telegram webhook secret rejected" },
        },
      },
    },
    "/api/v1/audit": {
      get: { responses: { "200": { description: "Audit trail" } } },
    },
    "/api/v1/settings/general": {
      get: {
        responses: {
          "200": {
            description:
              "General settings and verified GitHub beta update status",
          },
        },
      },
    },
    "/api/v1/settings/core-update-operations": {
      post: {
        parameters: [{ name: "X-Reauth-Token", in: "header", required: true }],
        responses: {
          "201": { description: "Signed Core update operation started" },
          "409": {
            description:
              "Update unavailable, unsupported, unconfigured, or busy",
          },
        },
      },
    },
    "/api/v1/settings/core-update-operations/{operationId}": {
      get: {
        parameters: [{ name: "operationId", in: "path", required: true }],
        responses: { "200": { description: "Core update operation status" } },
      },
    },
    "/api/v1/settings/core-update-operations/{operationId}/advance": {
      post: {
        parameters: [
          { name: "operationId", in: "path", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        responses: {
          "200": { description: "One signed Core update stage completed" },
        },
      },
    },
  },
} as const;
