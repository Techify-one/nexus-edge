import { z } from "zod";
import type { Context } from "hono";
import { sha256 } from "@app/webhook-contract";
import type { HonoEnv } from "../env.js";
import { canPermission } from "../lib/ability.js";
import { AppError } from "../lib/http.js";
import { parseJson } from "../lib/values.js";
import { archivedAssetBytes } from "../routes/plugin-runtime.js";

type Json = Record<string, any>;
export type McpAction = {
  name: string;
  title: string;
  titles?: Record<string, string>;
  description: string;
  method: string;
  path: string;
  permissions: string[];
  optionalPermissions: string[];
  inputSchema: Json;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
};
export type McpPlugin = {
  id: string;
  name: string;
  status: string;
  enabled: boolean;
  allowedActions: string[];
  actions: McpAction[];
};

// Only local references are permitted; never fetch a schema URL supplied by a plugin.
function resolveSchema(value: any, document: Json, depth = 0): any {
  if (depth > 24) throw new Error("MCP schema is too deeply nested");
  if (Array.isArray(value))
    return value.map((item) => resolveSchema(item, document, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/"))
      throw new Error("Unsupported MCP schema reference");
    const target = value.$ref
      .slice(2)
      .split("/")
      .reduce(
        (node: any, key: string) =>
          node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")],
        document,
      );
    if (!target) throw new Error("Missing MCP schema reference");
    return resolveSchema(target, document, depth + 1);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      resolveSchema(child, document, depth + 1),
    ]),
  );
}

export function actionsFromOpenApi(
  pluginId: string,
  permissions: string[],
  document: Json,
): McpAction[] {
  const actions: McpAction[] = [];
  const names = new Set<string>();
  const explicitContract = Object.values(document.paths ?? {}).some(
    (item: any) =>
      item &&
      typeof item === "object" &&
      Object.values(item).some(
        (operation: any) =>
          operation &&
          typeof operation === "object" &&
          Object.hasOwn(operation, "x-nexus-mcp"),
      ),
  );
  const prefix = `/api/v1/p/${pluginId}/`;
  for (const [path, item] of Object.entries(document.paths ?? {}) as [
    string,
    Json,
  ][]) {
    if (
      !path.startsWith(prefix) ||
      /[?%\\#]|\/\.{1,2}(?:\/|$)|\/\//u.test(path) ||
      path.slice(prefix.length).startsWith("__installer")
    )
      continue;
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = item[method];
      // Adapt concrete permission extensions from older signed packages.
      // Route names are never used to infer permissions.
      const legacyPermissions =
        operation?.["x-required-permissions"] ??
        (operation?.["x-nexus-permission"]
          ? [operation["x-nexus-permission"]]
          : undefined);
      const legacyName = operation?.operationId;
      const declaration =
        operation?.["x-nexus-mcp"] ??
        (!explicitContract &&
        legacyPermissions &&
        typeof legacyName === "string"
          ? {
              name: legacyName.startsWith(`${pluginId}_`)
                ? legacyName
                : `${pluginId}_${legacyName}`,
              permissions: legacyPermissions,
              readOnly: method === "get",
              destructive: method !== "get",
            }
          : undefined);
      if (!declaration || declaration.enabled === false) continue;
      if (
        !operation["x-nexus-mcp"] &&
        operation.requestBody &&
        !operation.requestBody.content?.["application/json"]
      )
        continue;
      const responseTypes = Object.entries(operation.responses ?? {})
        .filter(([status]) => /^2\d\d$/u.test(status))
        .flatMap(([, response]: [string, any]) =>
          Object.keys(response?.content ?? {}),
        );
      if (
        responseTypes.length &&
        !responseTypes.some(
          (type) => type.includes("json") || type.startsWith("text/"),
        )
      )
        continue;
      const parsedDeclaration = z
        .object({
          name: z.string().min(1).max(128),
          permissions: z.array(z.string()).min(1).max(200),
          optionalPermissions: z.array(z.string()).max(200).default([]),
          titles: z.record(z.string(), z.string().min(1).max(200)).optional(),
          readOnly: z.boolean().optional(),
          destructive: z.boolean().optional(),
          idempotent: z.boolean().optional(),
        })
        .safeParse(declaration);
      if (!parsedDeclaration.success)
        throw new Error("Invalid MCP action declaration");
      const optionalPermissions = parsedDeclaration.data.optionalPermissions;
      if (
        !optionalPermissions.every(
          (key) => key.startsWith(`${pluginId}.`) && permissions.includes(key),
        )
      )
        throw new Error("Invalid optional MCP permissions");
      const required = parsedDeclaration.data.permissions;
      const name = declaration.name;
      if (
        !Array.isArray(required) ||
        !required.length ||
        !required.every(
          (key: unknown) =>
            typeof key === "string" &&
            key.startsWith(`${pluginId}.`) &&
            permissions.includes(key),
        )
      )
        throw new Error("MCP action must declare plugin permissions");
      if (
        typeof name !== "string" ||
        !name.startsWith(`${pluginId}_`) ||
        !/^[a-zA-Z0-9_]{1,128}$/u.test(name) ||
        names.has(name)
      )
        throw new Error("Invalid or duplicate MCP action name");
      names.add(name);
      const properties: Json = {};
      const topRequired: string[] = [];
      for (const location of ["path", "query"]) {
        const parameters = [
          ...(item.parameters ?? []),
          ...(operation.parameters ?? []),
        ].filter((parameter: Json) => parameter.in === location);
        // A path parameter is always required, including those omitted in older documents.
        if (location === "path")
          for (const match of path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)) {
            if (
              !parameters.some((parameter: Json) => parameter.name === match[1])
            )
              parameters.push({
                name: match[1],
                in: location,
                required: true,
                schema: { type: "string", minLength: 1, maxLength: 200 },
              });
          }
        if (!parameters.length) continue;
        const requiredParameters = parameters
          .filter(
            (parameter: Json) => parameter.required || location === "path",
          )
          .map((parameter: Json) => parameter.name);
        properties[location] = {
          type: "object",
          properties: Object.fromEntries(
            parameters.map((parameter: Json) => [
              parameter.name,
              resolveSchema(parameter.schema ?? { type: "string" }, document),
            ]),
          ),
          additionalProperties: false,
          ...(requiredParameters.length
            ? { required: requiredParameters }
            : {}),
        };
        if (requiredParameters.length) topRequired.push(location);
      }
      if (operation.requestBody) {
        const schema =
          operation.requestBody.content?.["application/json"]?.schema;
        if (!schema) throw new Error("MCP actions require JSON request bodies");
        properties.body = resolveSchema(schema, document);
        if (operation.requestBody.required) topRequired.push("body");
      }
      if (method !== "get")
        properties.idempotencyKey = {
          type: "string",
          minLength: 16,
          maxLength: 200,
          description: "Reuse the same key when retrying the same operation.",
        };
      if (method === "post" && declaration.readOnly !== true)
        topRequired.push("idempotencyKey");
      const inputSchema = {
        type: "object" as const,
        properties,
        additionalProperties: false,
        ...(topRequired.length ? { required: topRequired } : {}),
      };
      z.fromJSONSchema(inputSchema);
      actions.push({
        name,
        title: operation.summary ?? name,
        ...(declaration.titles ? { titles: declaration.titles } : {}),
        description: operation.description ?? operation.summary ?? name,
        method: method.toUpperCase(),
        path,
        permissions: required,
        optionalPermissions,
        inputSchema,
        readOnly: method === "get" || declaration.readOnly === true,
        destructive: method === "delete" || declaration.destructive === true,
        idempotent:
          method === "get" ||
          method === "put" ||
          method === "delete" ||
          declaration.idempotent === true,
      });
    }
  }
  return actions.sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadMcpPlugins(
  c: Context<HonoEnv>,
  pluginId?: string,
  enabledOnly = false,
): Promise<McpPlugin[]> {
  const rows = await c.get("db").query<Json>(
    `SELECT p.id, p.name, p.status, p.manifest_json AS manifest,
            s.enabled, s.allowed_actions_json AS "allowedActions",
            a.operation_id AS "operationId", a.sha256, a.byte_length AS "byteLength"
       FROM plugins p LEFT JOIN plugin_mcp_settings s ON s.plugin_id = p.id
       LEFT JOIN plugin_assets a ON a.plugin_id = p.id AND a.release_hash = p.release_hash AND a.path = 'openapi.json'
      WHERE p.status IN ('installed','disabled') ${pluginId ? "AND p.id = ?" : ""} ${enabledOnly ? "AND p.status = 'installed' AND s.enabled = 1" : ""} ORDER BY p.id`,
    pluginId ? [pluginId] : [],
  );
  const result: McpPlugin[] = [];
  for (const row of rows) {
    let actions: McpAction[] = [];
    if (row.operationId) {
      const bytes = await archivedAssetBytes(
        c,
        row.operationId,
        "openapi.json",
      );
      if (
        bytes.byteLength !== Number(row.byteLength) ||
        (await sha256(bytes)) !== row.sha256
      )
        throw new AppError(
          500,
          "PLUGIN_ASSET_CORRUPT",
          "Plugin action definitions are unavailable.",
        );
      try {
        actions = actionsFromOpenApi(
          row.id,
          parseJson<Json>(row.manifest, {}).permissions ?? [],
          JSON.parse(new TextDecoder().decode(bytes)),
        );
      } catch {
        throw new AppError(
          422,
          "MCP_DEFINITION_INVALID",
          "The plugin contains invalid MCP action definitions.",
        );
      }
    }
    result.push({
      id: row.id,
      name: row.name,
      status: row.status,
      enabled: Boolean(row.enabled),
      allowedActions: parseJson<string[]>(row.allowedActions, []).filter(
        (name) => actions.some((action) => action.name === name),
      ),
      actions,
    });
  }
  return result;
}

export const permittedMcpActions = (
  c: Context<HonoEnv>,
  plugins: McpPlugin[],
) =>
  plugins.flatMap((plugin) =>
    plugin.enabled && plugin.status === "installed"
      ? plugin.actions
          .filter(
            (action) =>
              plugin.allowedActions.includes(action.name) &&
              action.permissions.every((key) =>
                canPermission(c.get("ability"), key),
              ),
          )
          .map((action) => ({
            ...action,
            pluginId: plugin.id,
            delegatedPermissions: [
              ...new Set([
                ...action.permissions,
                ...action.optionalPermissions.filter((key) =>
                  canPermission(c.get("ability"), key),
                ),
              ]),
            ],
          }))
      : [],
  );

export function actionRequest(action: McpAction, args: unknown): Request {
  const parsed = z.fromJSONSchema(action.inputSchema).safeParse(args ?? {});
  if (!parsed.success)
    throw new AppError(422, "VALIDATION_ERROR", "Invalid action arguments.");
  const input = parsed.data as Json;
  if (action.method === "POST" && !action.readOnly && input.body === undefined)
    input.body = {};
  const path = action.path.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/gu,
    (_, key: string) => {
      const value = String(input.path?.[key] ?? "");
      if (
        !value ||
        value === "." ||
        value === ".." ||
        /[\/\\%\u0000-\u001f]/u.test(value)
      )
        throw new AppError(422, "VALIDATION_ERROR", "Invalid path parameter.");
      return encodeURIComponent(value);
    },
  );
  const url = new URL(path, "https://core.internal");
  for (const [key, value] of Object.entries(input.query ?? {}))
    if (value !== undefined && value !== null)
      url.searchParams.set(key, String(value));
  const headers = new Headers();
  if (input.idempotencyKey)
    headers.set("Idempotency-Key", input.idempotencyKey);
  if (input.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(url, {
    method: action.method,
    headers,
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
  });
}
