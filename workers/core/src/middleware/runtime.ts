import { createDatabase } from "@app/database";
import { SCHEMA_VERSION } from "@app/db-schema/common";
import type { MiddlewareHandler } from "hono";
import { createAuth } from "../auth/factory.js";
import type { HonoEnv } from "../env.js";
import { AppError } from "../lib/http.js";

type Settings = {
  installationId: string;
  databaseProvider: string;
  schemaVersion: number;
};

export const requestContext: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const requestId =
    c.req.header("X-Request-Id")?.slice(0, 100) ||
    `req_${crypto.randomUUID().replaceAll("-", "")}`;
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  const db = await createDatabase(c.env);
  c.set("db", db);
  c.set("auth", createAuth(c.env, db));
  try {
    const settings = await db.first<Settings>(
      `SELECT installation_id AS "installationId", database_provider AS "databaseProvider", schema_version AS "schemaVersion"
         FROM app_settings WHERE id = 'system'`,
    );
    if (!settings)
      throw new AppError(
        503,
        "DATABASE_NOT_PROVISIONED",
        "The installation has not been provisioned yet.",
      );
    if (
      settings.installationId !== c.env.APP_INSTALLATION_ID ||
      settings.databaseProvider !== c.env.DATABASE_PROVIDER ||
      Number(settings.schemaVersion) !== SCHEMA_VERSION
    ) {
      throw new AppError(
        503,
        "INSTALLATION_MISMATCH",
        "The database does not match this installation or version.",
      );
    }
    await next();
  } finally {
    await db.close();
  }
};

export const securityHeaders: MiddlewareHandler<HonoEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header(
    "Permissions-Policy",
    "camera=(), microphone=(self), display-capture=(self), geolocation=()",
  );
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
};
