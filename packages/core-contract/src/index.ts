export type AuthMethod = "cookie" | "bearer" | "api_key";

export type PluginContext = {
  userId: string;
  permissions: string[];
  requestId: string;
};

export type PluginPublicContext = {
  pluginId: string;
  requestId: string;
};

export type RequestPrincipal = {
  userId: string;
  authMethod: AuthMethod;
  credentialId?: string;
  credentialScopes?: string[];
};

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION_ERROR"
  | "RATE_LIMITED"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export type ApiErrorEnvelope = {
  error: {
    code: ErrorCode | string;
    message: string;
    fieldErrors?: Record<string, string[]>;
    requestId: string;
  };
};

export const createId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export const toIso = (value: number | Date = Date.now()): string =>
  new Date(value).toISOString();

export function parsePermission(key: string): {
  action: string;
  subject: string;
} {
  const parts = key.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new Error(`Invalid permission key: ${key}`);
  }
  const [namespace, resource, action] = parts as [string, string, string];
  return { action, subject: `${namespace}.${resource}` };
}

export function permissionNamespace(key: string): string {
  return key.split(".")[0] ?? "";
}

export function redactUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.hostname}/…`;
}
