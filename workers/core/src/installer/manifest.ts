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
    runtimeBindings: z.array(z.literal("ai")).max(1).optional(),
    tablePrefix: z.string(),
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
  });

export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export const CORE_ROUTE_KEYS = new Set([
  "crm.home",
  "crm.leads",
  "meta_ads.home",
  "meta_ads.dashboard",
  "meta_ads.accounts",
  "soletrando.children",
]);

export function validateManifestPolicy(
  manifest: PluginManifest,
  coreVersion: string,
  allowedFlagsRaw = "",
): void {
  if (semver.gt(manifest.coreMinVersion, coreVersion))
    throw new Error(`Plugin requires Core ${manifest.coreMinVersion}`);
  if (manifest.apiVersion !== 1)
    throw new Error("Unsupported plugin apiVersion");
  const allowedFlags = new Set(
    allowedFlagsRaw
      .split(",")
      .map((flag) => flag.trim())
      .filter(Boolean),
  );
  if (manifest.compatibilityFlags.some((flag) => !allowedFlags.has(flag)))
    throw new Error(
      "Manifest contains a compatibility flag outside the Core allowlist",
    );
  if (manifest.menu.some((entry) => !CORE_ROUTE_KEYS.has(entry.routeKey)))
    throw new Error(
      "The plugin frontend is not available in this Core version",
    );
}
