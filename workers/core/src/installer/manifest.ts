import semver from "semver";
import { z } from "zod";

const permission = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,31}\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u);
const compatibilityDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)),
    "invalid compatibility date",
  );
const runtimeBinding = z.enum(["ai", "r2"]);
const localizedMetadata = z
  .object({
    name: z.string().min(2).max(80),
    menuTitles: z.record(z.string().min(3).max(100), z.string().min(1).max(80)),
  })
  .strict();

export const pluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/u),
    name: z.string().min(2).max(80),
    version: z
      .string()
      .refine((value) => Boolean(semver.valid(value)), "invalid SemVer"),
    apiVersion: z.number().int().positive(),
    coreMinVersion: z
      .string()
      .refine((value) => Boolean(semver.valid(value)), "invalid SemVer"),
    compatibilityDate,
    compatibilityFlags: z.array(z.string()).max(20),
    databaseDialects: z.tuple([z.literal("d1"), z.literal("postgres")]),
    runtimeBindings: z.array(runtimeBinding).max(2).optional(),
    tablePrefix: z.string(),
    localizedMetadata: z
      .object({
        "pt-BR": localizedMetadata.optional(),
        en: localizedMetadata.optional(),
      })
      .strict()
      .optional(),
    permissions: z.array(permission).max(200),
    menu: z
      .array(
        z.object({
          title: z.string().min(1).max(80),
          routeKey: z.string().min(3).max(100),
        }),
      )
      .max(30),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.tablePrefix !== `${manifest.id}_`)
      context.addIssue({
        code: "custom",
        message: "tablePrefix must equal <id>_",
        path: ["tablePrefix"],
      });
    if (manifest.permissions.some((key) => !key.startsWith(`${manifest.id}.`)))
      context.addIssue({
        code: "custom",
        message: "permission namespace must match id",
        path: ["permissions"],
      });
    const runtimeBindings = manifest.runtimeBindings ?? [];
    if (new Set(runtimeBindings).size !== runtimeBindings.length)
      context.addIssue({
        code: "custom",
        message: "runtimeBindings cannot contain duplicates",
        path: ["runtimeBindings"],
      });
    if (runtimeBindings.join(",") !== [...runtimeBindings].sort().join(","))
      context.addIssue({
        code: "custom",
        message: "runtimeBindings must use canonical order: ai, r2",
        path: ["runtimeBindings"],
      });
    const menuRouteKeys = new Set(manifest.menu.map((entry) => entry.routeKey));
    for (const [locale, metadata] of Object.entries(
      manifest.localizedMetadata ?? {},
    ))
      for (const routeKey of Object.keys(metadata?.menuTitles ?? {}))
        if (!menuRouteKeys.has(routeKey))
          context.addIssue({
            code: "custom",
            message: "localized menu title must reference a manifest route",
            path: ["localizedMetadata", locale, "menuTitles", routeKey],
          });
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export class PluginManifestPolicyError extends Error {
  constructor(
    readonly code:
      | "core_version_unsupported"
      | "api_version_unsupported"
      | "compatibility_flag_unsupported"
      | "frontend_unavailable",
  ) {
    super(code);
    this.name = "PluginManifestPolicyError";
  }
}

export const CORE_ROUTE_KEYS = new Set([
  "crm.home",
  "crm.leads",
  "meta_ads.home",
  "meta_ads.dashboard",
  "meta_ads.accounts",
  "soletrando.children",
  "meeting_recorder.home",
]);

export function validateManifestPolicy(
  manifest: PluginManifest,
  coreVersion: string,
  allowedFlagsRaw = "",
): void {
  if (semver.gt(manifest.coreMinVersion, coreVersion))
    throw new PluginManifestPolicyError("core_version_unsupported");
  if (manifest.apiVersion !== 1)
    throw new PluginManifestPolicyError("api_version_unsupported");
  const allowedFlags = new Set(
    allowedFlagsRaw
      .split(",")
      .map((flag) => flag.trim())
      .filter(Boolean),
  );
  if (manifest.compatibilityFlags.some((flag) => !allowedFlags.has(flag)))
    throw new PluginManifestPolicyError("compatibility_flag_unsupported");
  if (manifest.menu.some((entry) => !CORE_ROUTE_KEYS.has(entry.routeKey)))
    throw new PluginManifestPolicyError("frontend_unavailable");
}
