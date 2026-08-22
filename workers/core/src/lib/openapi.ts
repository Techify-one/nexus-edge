export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "Modular Workers App API",
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
          groupIds: {
            type: "array",
            maxItems: 50,
            items: { type: "string" },
            default: [],
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
    "/api/v1/me/api-keys": {
      get: { responses: { "200": { description: "Personal keys" } } },
      post: {
        parameters: [{ name: "X-Reauth-Token", in: "header", required: true }],
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
      get: { responses: { "200": { description: "Installed plugins" } } },
    },
    "/api/v1/plugin-operations": {
      get: { responses: { "200": { description: "Installer operations" } } },
      post: {
        parameters: [
          { name: "Idempotency-Key", in: "header", required: true },
          { name: "X-Reauth-Token", in: "header", required: true },
        ],
        requestBody: {
          content: { "multipart/form-data": { schema: { type: "object" } } },
        },
        responses: { "201": { description: "Operation created" } },
      },
    },
    "/api/v1/audit": {
      get: { responses: { "200": { description: "Audit trail" } } },
    },
  },
} as const;
