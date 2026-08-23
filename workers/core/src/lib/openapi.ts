export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Nexus Edge API",
    version: "1.0.0",
    description:
      "API-first administration, CRM, webhooks and plugin installation.",
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
    "/api/v1/audit": {
      get: { responses: { "200": { description: "Audit trail" } } },
    },
  },
} as const;
