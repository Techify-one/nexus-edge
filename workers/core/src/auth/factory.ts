import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import type { DatabasePort } from "@app/database";
import type { CoreEnv } from "../env.js";

export function createAuth(env: CoreEnv, db: DatabasePort) {
  return betterAuth({
    appName: "Nexus Edge",
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: env.TRUSTED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    database: drizzleAdapter(db.orm as never, {
      provider: db.provider === "d1" ? "sqlite" : "pg",
      usePlural: false,
    }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 200,
      requireEmailVerification: false,
    },
    user: {
      additionalFields: {
        active: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      freshAge: 60 * 10,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: env.BETTER_AUTH_URL.startsWith("https://"),
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: env.BETTER_AUTH_URL.startsWith("https://"),
      },
    },
    rateLimit: { enabled: true, window: 60, max: 100, storage: "database" },
    plugins: [
      bearer(),
      apiKey({
        references: "user",
        apiKeyHeaders: "x-api-key",
        enableSessionForAPIKeys: true,
        disableKeyHashing: false,
        defaultPrefix: "app_",
        requireName: true,
        startingCharactersConfig: { shouldStore: true, charactersLength: 12 },
        keyExpiration: {
          defaultExpiresIn: 60 * 60 * 24 * 90,
          minExpiresIn: 60 * 60 * 24,
          maxExpiresIn: 60 * 60 * 24 * 365,
        },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
      }),
    ],
  });
}
