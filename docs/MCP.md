# MCP connections

The Core exposes a stateless MCP Streamable HTTP endpoint at `/mcp`. Each
installed plugin declares its own tools in the integrity-checked `openapi.json`
inside its signed package. No plugin IDs, tool names or business routes are
compiled into the Core.

Older packages declaring `operationId` plus `x-nexus-permission` or
`x-required-permissions` are adapted using those explicit permissions. This
keeps existing independently installed plugins compatible, including Chat IA
Free, without repackaging their signed code. Binary operations remain excluded.
When any operation declares `x-nexus-mcp`, that explicit contract is authoritative:
unmarked operations are excluded, even when they have older permission metadata.

In **Plugins → Installed → plugin details → MCP access**, turn MCP on and select
the permitted actions, then click **Save** once to apply them together. **Select
all** and **Deselect all** change the local selection without sending requests.
The activation switch also remains a draft until saved. **Discard changes**
restores the saved configuration. Failed saves keep the draft available to retry;
the server configuration remains unchanged until a save succeeds. Both settings survive
Core and plugin updates, disable/re-enable, and conservative reinstall. MCP
starts disabled, actions are opt-in, and new actions remain blocked. Disabled or
uninstalled plugins cannot expose or execute tools. Plugin updates retain
existing allowlists; removed action names are ignored.

Every list and call intersects the installation's allowlist, the current user's
permissions, and the connected credential's scopes. The private Service Binding
receives only the concrete permissions needed by that action. Ownership rules,
optimistic version checks, confirmations and other plugin business rules still
apply. Cookies, API keys and OAuth tokens never reach the plugin Worker. Audit
records action names and outcomes, without arguments, results or secrets.

## Connecting clients

Open **MCP connections** to copy the canonical endpoint, inspect connections,
and revoke access immediately. OAuth uses authorization code + PKCE S256,
dynamic public-client registration, resource audience binding, short-lived
access tokens and rotating refresh tokens. Browser login uses the existing
Nexus account and an explicit consent screen. Only token hashes are stored.
Saving a plugin action change takes effect on the next call, including calls from
clients with cached tool lists. OAuth snapshots the concrete permissions approved
at consent time; refreshing a client's tool catalog does not expand that grant.

After enabling more actions, open the existing connection in **MCP connections**,
review the listed actions, and choose **Update permissions**. Then refresh tools
in the assistant. The hub shows authorized versus available action counts and
flags outdated grants. This explicit, cookie-authenticated consent updates only
the current user's selected active connection, without replacing its tokens or
executing tools. The submitted action names must exactly match the current
review; changed allowlists or user permissions require another review. Expired,
revoked, cross-user and API-key attempts are rejected. Initial authorization is
blocked when no actions are enabled, avoiding a successful-looking empty link.
Reconnecting and consenting again is also supported. Neither enabling actions
nor refreshing metadata silently broadens another connection's permissions.

Add the endpoint as a remote HTTP server in the chosen client, select OAuth,
and authorize it in Nexus. Availability depends on that client's account and
custom connector settings. Product-specific commands, configuration examples
and official sources are kept in [the client configuration examples](../examples/mcp-clients.json).

Clients accepting custom credentials may instead send a personal Nexus API key
in `X-API-Key` or `Authorization: Bearer app_…`. Create a separate key per
client, with only the required plugin permissions. A key never acquires the
administrator's unlimited privileges. Revocation uses the existing API-key page.
External clients must be connected in their own account; deploying Nexus does
not automatically authorize an external assistant account.

## Plugin contract

Declare each JSON operation explicitly; public routes, installer routes and
undeclared operations are never tools:

```json
{
  "/api/v1/p/inventory/products/{id}": {
    "get": {
      "summary": "Read a product",
      "parameters": [
        {
          "in": "path",
          "name": "id",
          "required": true,
          "schema": { "type": "string" }
        }
      ],
      "x-nexus-mcp": {
        "name": "inventory_get_product",
        "permissions": ["inventory.product.read"],
        "titles": { "pt-BR": "Consultar produto", "en": "Read a product" },
        "readOnly": true,
        "destructive": false
      },
      "responses": { "200": { "description": "Product" } }
    }
  }
}
```

Names are immutable, start with `<plugin-id>_`, contain letters, digits or
underscores, and are unique (maximum 128 characters). Every action requires at
least one permission declared in that plugin's manifest.
Optionally declare `optionalPermissions` for existing broader ownership scopes,
such as reading all users' records. These are delegated only when the current
user and credential already possess them; they never grant additional access.
Declare query
parameters, path parameters and JSON request bodies with complete schemas.
Local `#/components/schemas/...` references are resolved without network calls.
The MCP argument object groups inputs under `path`, `query` and `body`.
Mutations also accept `idempotencyKey`; non-read-only POST tools require one.
Reuse the key only when retrying the same request. Binary uploads, browser
capture, public callbacks and secret provisioning are not MCP actions.

Schema validation, bounded input/output, origin checks, authentication, current
permissions and audit execute in the Core. The transport supports protocol
versions 2025-03-26, 2025-06-18 and 2025-11-25, JSON responses, pagination,
initialize, ping, tools/list and tools/call. Notifications return 202; GET and
DELETE return 405 because the server has no persistent transport sessions.
Clients should refresh tool discovery after configuration changes.

## Operations

Apply paired migration `0011_mcp.sql` using the selected provider. Preserve the
existing provider and installation ID. Assets configuration must route `/mcp`,
`/oauth/*` and `/.well-known/*` through the Worker before the SPA fallback.
The production workflow checks the OAuth discovery documents and verifies that
unauthenticated `/mcp` requests receive 401 plus a resource discovery challenge.
Run `pnpm test`, including the SQLite-backed MCP security and lifecycle tests,
and the normal deployment checks before publishing.
