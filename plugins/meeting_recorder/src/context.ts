import type {
  PluginContext,
  PluginInstallerContext,
  PluginPublicContext,
} from "@app/core-contract";
import { createDatabase } from "@app/database";
import type { MiddlewareHandler } from "hono";
import type { MeetingRecorderEnv } from "./env.js";

const decode = (encoded: string): unknown => {
  const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
  );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
};

const isUserContext = (value: unknown): value is PluginContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<PluginContext>;
  return Boolean(
    context.userId &&
    context.requestId &&
    typeof context.origin === "string" &&
    /^https?:\/\/[^/]+$/u.test(context.origin) &&
    Array.isArray(context.permissions) &&
    context.permissions.every((permission) => typeof permission === "string"),
  );
};

const isPublicContext = (value: unknown): value is PluginPublicContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<PluginPublicContext>;
  return Boolean(context.pluginId === "meeting_recorder" && context.requestId);
};

const isInstallerContext = (
  value: unknown,
): value is PluginInstallerContext => {
  if (!value || typeof value !== "object") return false;
  const context = value as Partial<PluginInstallerContext>;
  return Boolean(
    context.pluginId === "meeting_recorder" &&
    context.operationId &&
    context.requestId,
  );
};

export const contextMiddleware: MiddlewareHandler<MeetingRecorderEnv> = async (
  c,
  next,
) => {
  if (c.req.path === "/health") return next();
  const encoded = {
    user: c.req.header("X-Plugin-Context"),
    public: c.req.header("X-Plugin-Public-Context"),
    installer: c.req.header("X-Plugin-Installer-Context"),
  };
  if (Object.values(encoded).filter(Boolean).length !== 1)
    return c.json(
      {
        error: {
          code: "MISSING_PLUGIN_CONTEXT",
          message: "Exactly one internal context is required.",
          requestId: "unknown",
        },
      },
      401,
    );
  try {
    if (encoded.user) {
      const context = decode(encoded.user);
      if (!isUserContext(context)) throw new Error("invalid user context");
      c.set("pluginContext", context);
    } else if (encoded.public) {
      const context = decode(encoded.public);
      if (!isPublicContext(context)) throw new Error("invalid public context");
      c.set("publicContext", context);
    } else {
      const context = decode(encoded.installer!);
      if (!isInstallerContext(context))
        throw new Error("invalid installer context");
      c.set("installerContext", context);
    }
  } catch {
    return c.json(
      {
        error: {
          code: "INVALID_PLUGIN_CONTEXT",
          message: "The internal context is invalid.",
          requestId: "unknown",
        },
      },
      401,
    );
  }
  const db = await createDatabase(c.env);
  c.set("db", db);
  try {
    await next();
  } finally {
    await db.close();
  }
};

export const requestId = (c: {
  get: {
    (name: "pluginContext"): PluginContext | undefined;
    (name: "publicContext"): PluginPublicContext | undefined;
    (name: "installerContext"): PluginInstallerContext | undefined;
  };
}): string =>
  c.get("pluginContext")?.requestId ??
  c.get("publicContext")?.requestId ??
  c.get("installerContext")?.requestId ??
  "unknown";
