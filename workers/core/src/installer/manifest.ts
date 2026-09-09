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
const packagePath = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.split("/").some((part) => part === "" || part === ".."),
    "invalid package path",
  );
const contributionPath = z
  .string()
  .regex(/^\/[A-Za-z0-9_@./:-]*$/u)
  .max(200)
  .refine(
    (value) =>
      value === "/" ||
      !value
        .split("/")
        .slice(1)
        .some((part) => part === "" || part === "." || part === ".."),
    "invalid route path",
  );
const pluginResourceBase = {
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/u),
  capabilityVersion: z.literal(1).default(1),
  binding: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),
  required: z.boolean().default(true),
  retention: z.enum(["preserve", "delete_on_purge"]).default("preserve"),
};
const pluginResource = z.discriminatedUnion("type", [
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("database"),
      configuration: z
        .object({ mode: z.literal("installation").default("installation") })
        .strict()
        .default({ mode: "installation" }),
    })
    .strict(),
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("r2"),
      configuration: z.object({}).strict().default({}),
    })
    .strict(),
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("kv"),
      configuration: z
        .object({ jurisdiction: z.enum(["eu", "fedramp", "us"]).optional() })
        .strict()
        .default({}),
    })
    .strict(),
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("queue"),
      configuration: z
        .object({
          consumer: z.boolean().default(false),
          deadLetterResource: z
            .string()
            .regex(/^[a-z][a-z0-9_-]{0,47}$/u)
            .optional(),
          settings: z
            .object({
              batch_size: z.number().int().min(1).max(100).optional(),
              max_concurrency: z.number().int().min(1).max(250).optional(),
              max_retries: z.number().int().min(0).max(100).optional(),
              max_wait_time_ms: z.number().int().min(0).max(60_000).optional(),
              retry_delay: z.number().int().min(0).max(43_200).optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .default({ consumer: false }),
    })
    .strict(),
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("durable_object"),
      configuration: z
        .object({
          className: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u),
          storage: z.literal("sqlite").default("sqlite"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("cron"),
      configuration: z
        .object({
          schedules: z
            .array(
              z
                .string()
                .min(9)
                .max(100)
                .regex(/^(?:\S+\s+){4}\S+$/u),
            )
            .min(1)
            .max(5),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...pluginResourceBase,
      type: z.literal("ai"),
      configuration: z.object({}).strict().default({}),
    })
    .strict(),
]);
const localizedMetadata = z
  .object({
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    menuTitles: z.record(z.string().min(3).max(100), z.string().min(1).max(80)),
    permissionLabels: z
      .record(permission, z.string().min(1).max(120))
      .optional(),
  })
  .strict();

export const pluginManifestSchema = z
  .object({
    manifestVersion: z.literal(2).optional(),
    packageFormat: z.literal(2).optional(),
    id: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/u),
    name: z.string().min(2).max(80),
    description: z.string().max(500).optional(),
    publisher: z
      .object({
        id: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
        name: z.string().min(2).max(100),
      })
      .strict()
      .optional(),
    version: z
      .string()
      .refine((value) => Boolean(semver.valid(value)), "invalid SemVer"),
    apiVersion: z.number().int().positive(),
    coreMinVersion: z
      .string()
      .refine((value) => Boolean(semver.valid(value)), "invalid SemVer"),
    compatibilityDate,
    compatibilityFlags: z.array(z.string()).max(20),
    databaseDialects: z
      .array(z.enum(["d1", "postgres"]))
      .min(1)
      .max(2),
    runtimeBindings: z.array(runtimeBinding).max(2).optional(),
    optionalRuntimeBindings: z.array(runtimeBinding).max(2).optional(),
    engines: z
      .object({
        hostApi: z.literal(1),
        coreApi: z.literal(1),
      })
      .strict()
      .optional(),
    frontend: z
      .object({
        entry: packagePath.refine((value) => value.startsWith("frontend/")),
        styles: z
          .array(packagePath.refine((value) => value.startsWith("frontend/")))
          .max(20)
          .default([]),
        isolation: z.enum(["shadow", "light"]).default("shadow"),
        persistentSurface: z.boolean().default(false),
        routes: z
          .array(
            z
              .object({
                routeKey: z.string().min(3).max(100),
                path: contributionPath,
              })
              .strict(),
          )
          .min(1)
          .max(50),
        publicRoutes: z
          .array(
            z
              .object({
                routeKey: z.string().min(3).max(100),
                path: contributionPath,
              })
              .strict(),
          )
          .max(20)
          .default([]),
      })
      .strict()
      .optional(),
    publicRoutes: z.array(contributionPath).max(30).optional(),
    secrets: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u),
            label: z.string().min(1).max(100),
            required: z.boolean().default(true),
            permission: permission,
          })
          .strict(),
      )
      .max(50)
      .optional(),
    resources: z.array(pluginResource).max(20).optional(),
    dependencies: z
      .array(
        z
          .object({
            pluginId: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/u),
            version: z
              .string()
              .min(1)
              .max(100)
              .refine(
                (value) => Boolean(semver.validRange(value)),
                "invalid SemVer range",
              ),
            optional: z.boolean().default(false),
          })
          .strict(),
      )
      .max(10)
      .optional(),
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
        z
          .object({
            title: z.string().min(1).max(80),
            routeKey: z.string().min(3).max(100),
            path: contributionPath.optional(),
          })
          .strict(),
      )
      .max(30),
  })
  .strict()
  .superRefine((manifest, context) => {
    if ((manifest.manifestVersion === 2) !== (manifest.packageFormat === 2))
      context.addIssue({
        code: "custom",
        message: "manifestVersion and packageFormat must both be 2",
        path: ["packageFormat"],
      });
    if (manifest.packageFormat === 2 && !manifest.engines)
      context.addIssue({
        code: "custom",
        message: "package format 2 requires engines",
        path: ["engines"],
      });
    if (manifest.packageFormat === 2 && !manifest.publisher)
      context.addIssue({
        code: "custom",
        message: "package format 2 requires publisher identity",
        path: ["publisher"],
      });
    if (manifest.packageFormat === 2 && !manifest.frontend)
      context.addIssue({
        code: "custom",
        message: "package format 2 requires a frontend entrypoint",
        path: ["frontend"],
      });
    if (
      new Set(manifest.databaseDialects).size !==
        manifest.databaseDialects.length ||
      manifest.databaseDialects.join(",") !==
        [...manifest.databaseDialects].sort().join(",")
    )
      context.addIssue({
        code: "custom",
        message: "databaseDialects must be unique and use canonical order",
        path: ["databaseDialects"],
      });
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
    if (new Set(manifest.permissions).size !== manifest.permissions.length)
      context.addIssue({
        code: "custom",
        message: "permissions must be unique",
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
    const optionalRuntimeBindings = manifest.optionalRuntimeBindings ?? [];
    if (
      new Set(optionalRuntimeBindings).size !== optionalRuntimeBindings.length
    )
      context.addIssue({
        code: "custom",
        message: "optionalRuntimeBindings cannot contain duplicates",
        path: ["optionalRuntimeBindings"],
      });
    if (
      optionalRuntimeBindings.join(",") !==
      [...optionalRuntimeBindings].sort().join(",")
    )
      context.addIssue({
        code: "custom",
        message: "optionalRuntimeBindings must use canonical order: ai, r2",
        path: ["optionalRuntimeBindings"],
      });
    for (const binding of optionalRuntimeBindings)
      if (runtimeBindings.includes(binding))
        context.addIssue({
          code: "custom",
          message: "a runtime binding cannot be both required and optional",
          path: ["optionalRuntimeBindings"],
        });
    if (
      manifest.packageFormat === 2 &&
      (manifest.runtimeBindings?.length ||
        manifest.optionalRuntimeBindings?.length)
    )
      context.addIssue({
        code: "custom",
        message:
          "package format 2 must declare resources instead of legacy runtimeBindings",
        path: ["resources"],
      });
    const menuRouteKeys = new Set(manifest.menu.map((entry) => entry.routeKey));
    if (
      new Set(manifest.menu.map((entry) => entry.routeKey)).size !==
      manifest.menu.length
    )
      context.addIssue({
        code: "custom",
        message: "menu route keys must be unique",
        path: ["menu"],
      });
    const frontendRouteKeys = new Set(
      manifest.frontend?.routes.map((route) => route.routeKey) ?? [],
    );
    const frontendPaths =
      manifest.frontend?.routes.map((route) => route.path) ?? [];
    if (new Set(frontendPaths).size !== frontendPaths.length)
      context.addIssue({
        code: "custom",
        message: "frontend route paths must be unique",
        path: ["frontend", "routes"],
      });
    const frontendStyles = manifest.frontend?.styles ?? [];
    if (new Set(frontendStyles).size !== frontendStyles.length)
      context.addIssue({
        code: "custom",
        message: "frontend styles must be unique",
        path: ["frontend", "styles"],
      });
    const publicFrontendRoutes = manifest.frontend?.publicRoutes ?? [];
    const publicFrontendRouteKeys = publicFrontendRoutes.map(
      (route) => route.routeKey,
    );
    const publicFrontendPaths = publicFrontendRoutes.map((route) => route.path);
    if (
      new Set(publicFrontendRouteKeys).size !==
        publicFrontendRouteKeys.length ||
      new Set(publicFrontendPaths).size !== publicFrontendPaths.length
    )
      context.addIssue({
        code: "custom",
        message: "public frontend routes must have unique keys and paths",
        path: ["frontend", "publicRoutes"],
      });
    for (const [index, route] of publicFrontendRoutes.entries())
      if (
        route.path === "/" ||
        ["/api", "/app", "/setup", "/login", "/accept-invite"].some(
          (reserved) =>
            route.path === reserved || route.path.startsWith(`${reserved}/`),
        )
      )
        context.addIssue({
          code: "custom",
          message: "public frontend route conflicts with a Core route",
          path: ["frontend", "publicRoutes", index, "path"],
        });
    for (const [index, route] of (manifest.frontend?.routes ?? []).entries())
      if (
        route.path !== `/app/p/${manifest.id}` &&
        !route.path.startsWith(`/app/p/${manifest.id}/`)
      )
        context.addIssue({
          code: "custom",
          message: "frontend routes must use the plugin route namespace",
          path: ["frontend", "routes", index, "path"],
        });
    for (const [index, item] of manifest.menu.entries()) {
      if (manifest.frontend && !frontendRouteKeys.has(item.routeKey))
        context.addIssue({
          code: "custom",
          message: "menu route must be declared by the frontend",
          path: ["menu", index, "routeKey"],
        });
      if (item.path && !item.path.startsWith(`/app/p/${manifest.id}`))
        context.addIssue({
          code: "custom",
          message: "menu path must use the plugin route namespace",
          path: ["menu", index, "path"],
        });
    }
    const resourceNames =
      manifest.resources?.map((resource) => resource.name) ?? [];
    const resourceBindings =
      manifest.resources?.map((resource) => resource.binding) ?? [];
    if (new Set(resourceNames).size !== resourceNames.length)
      context.addIssue({
        code: "custom",
        message: "resource names must be unique",
        path: ["resources"],
      });
    if (new Set(resourceBindings).size !== resourceBindings.length)
      context.addIssue({
        code: "custom",
        message: "resource bindings must be unique",
        path: ["resources"],
      });
    const publicRoutes = manifest.publicRoutes ?? [];
    if (new Set(publicRoutes).size !== publicRoutes.length)
      context.addIssue({
        code: "custom",
        message: "public routes must be unique",
        path: ["publicRoutes"],
      });
    const secretNames = (manifest.secrets ?? []).map((secret) => secret.name);
    if (new Set(secretNames).size !== secretNames.length)
      context.addIssue({
        code: "custom",
        message: "secret names must be unique",
        path: ["secrets"],
      });
    const dependencyIds = (manifest.dependencies ?? []).map(
      (dependency) => dependency.pluginId,
    );
    if (new Set(dependencyIds).size !== dependencyIds.length)
      context.addIssue({
        code: "custom",
        message: "dependencies must be unique",
        path: ["dependencies"],
      });
    const durableClasses = (manifest.resources ?? []).flatMap((resource) =>
      resource.type === "durable_object"
        ? [resource.configuration.className]
        : [],
    );
    if (new Set(durableClasses).size !== durableClasses.length)
      context.addIssue({
        code: "custom",
        message: "durable object class names must be unique",
        path: ["resources"],
      });
    const resourcesByName = new Map(
      (manifest.resources ?? []).map((resource) => [resource.name, resource]),
    );
    for (const [index, resource] of (manifest.resources ?? []).entries()) {
      if (
        resource.type === "queue" &&
        resource.configuration.deadLetterResource &&
        resourcesByName.get(resource.configuration.deadLetterResource)?.type !==
          "queue"
      )
        context.addIssue({
          code: "custom",
          message: "queue deadLetterResource must reference another queue",
          path: ["resources", index, "configuration", "deadLetterResource"],
        });
      if (
        resource.type === "durable_object" &&
        resource.retention !== "preserve"
      )
        context.addIssue({
          code: "custom",
          message: "durable object resources must be preserved on uninstall",
          path: ["resources", index, "retention"],
        });
    }
    for (const [index, secret] of (manifest.secrets ?? []).entries())
      if (!manifest.permissions.includes(secret.permission))
        context.addIssue({
          code: "custom",
          message: "secret permission must be declared by the plugin",
          path: ["secrets", index, "permission"],
        });
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
      | "host_api_unsupported"
      | "core_api_unsupported"
      | "compatibility_flag_unsupported"
      | "frontend_unavailable",
  ) {
    super(code);
    this.name = "PluginManifestPolicyError";
  }
}

export function validateManifestPolicy(
  manifest: PluginManifest,
  coreVersion: string,
  allowedFlagsRaw = "",
): void {
  if (semver.gt(manifest.coreMinVersion, coreVersion))
    throw new PluginManifestPolicyError("core_version_unsupported");
  if (manifest.apiVersion !== 1)
    throw new PluginManifestPolicyError("api_version_unsupported");
  if (manifest.engines && manifest.engines.hostApi !== 1)
    throw new PluginManifestPolicyError("host_api_unsupported");
  if (manifest.engines && manifest.engines.coreApi !== 1)
    throw new PluginManifestPolicyError("core_api_unsupported");
  const allowedFlags = new Set(
    allowedFlagsRaw
      .split(",")
      .map((flag) => flag.trim())
      .filter(Boolean),
  );
  if (manifest.compatibilityFlags.some((flag) => !allowedFlags.has(flag)))
    throw new PluginManifestPolicyError("compatibility_flag_unsupported");
  if (!manifest.frontend && manifest.menu.length > 0)
    throw new PluginManifestPolicyError("frontend_unavailable");
}
