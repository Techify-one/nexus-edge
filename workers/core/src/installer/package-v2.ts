import { strFromU8, unzipSync } from "fflate";
import { fromBase64url, sha256, stableJson } from "@app/webhook-contract";
import { z } from "zod";
import { pluginManifestSchema, type PluginManifest } from "./manifest.js";
import type { MigrationSet } from "./migrations.js";

export const MAX_PLUGIN_PACKAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PLUGIN_EXPANDED_BYTES = 24 * 1024 * 1024;
// The archive is persisted in D1 during a resumable install. Keeping the entry
// count bounded ensures that one archival batch also fits the Free-plan query
// budget even when every small file needs its own row.
export const MAX_PLUGIN_FILES = 25;
export const MAX_PLUGIN_FILE_BYTES = 6 * 1024 * 1024;

const migrationPath = /^migrations\/(d1|postgres)\/(\d{4}_[a-z0-9_]+)\.sql$/u;
const safePath =
  /^(?:manifest\.json|integrity\.json|signature\.json|openapi\.json|LICENSE|backend\/[A-Za-z0-9_.@/-]+|frontend\/[A-Za-z0-9_.@/-]+|locales\/[A-Za-z0-9_-]+\.json|resources\/[A-Za-z0-9_.@/-]+|migrations\/(?:d1|postgres)\/\d{4}_[a-z0-9_]+\.sql)$/u;

const integritySchema = z
  .object({
    algorithm: z.literal("sha256"),
    files: z.record(
      z.string(),
      z
        .object({
          sha256: z.string().min(40).max(100),
          size: z.number().int().nonnegative().max(MAX_PLUGIN_FILE_BYTES),
          contentType: z.string().min(1).max(160),
        })
        .strict(),
    ),
  })
  .strict();

export const packageSignatureSchema = z
  .object({
    algorithm: z.literal("Ed25519"),
    keyId: z.string().min(1).max(100),
    signature: z.string().min(40).max(200),
  })
  .strict();

export type PluginPackageParts = {
  manifest: PluginManifest;
  manifestSource?: string;
  worker: string;
  d1Migrations: MigrationSet;
  postgresMigrations: MigrationSet;
  /** Base64url-encoded package files not represented by the fields above. */
  files: Record<string, string>;
  rawBytes: number;
  archiveSha256?: string;
};

const validatePath = (path: string): void => {
  if (
    !safePath.test(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    path.endsWith(".map")
  )
    throw new Error(`PLUGIN_PACKAGE_PATH_INVALID:${path.slice(0, 120)}`);
};

const encode = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

export const decodePackageFile = (value: string): Uint8Array =>
  fromBase64url(value);

/**
 * Inspect the central directory before extraction. Object-based ZIP readers
 * overwrite duplicate names, which can otherwise make the bytes verified by
 * one tool differ from the bytes executed by another (a ZIP-confusion attack).
 * ZIP64 and multi-disk archives are deliberately outside package format 2.
 */
const inspectCentralDirectory = (archive: Uint8Array): Map<string, number> => {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  const minimumEocdSize = 22;
  const firstCandidate = Math.max(
    0,
    archive.byteLength - minimumEocdSize - 65_535,
  );
  let eocd = -1;
  for (
    let offset = archive.byteLength - minimumEocdSize;
    offset >= firstCandidate;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + minimumEocdSize + commentLength === archive.byteLength) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error("PLUGIN_PACKAGE_ZIP_INVALID");
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > MAX_PLUGIN_FILES ||
    centralOffset + centralSize !== eocd
  )
    throw new Error("PLUGIN_PACKAGE_ZIP_UNSUPPORTED");

  const entries = new Map<string, number>();
  const caseFoldedPaths = new Set<string>();
  let expandedBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || view.getUint32(offset, true) !== 0x02014b50)
      throw new Error("PLUGIN_PACKAGE_ZIP_INVALID");
    const flags = view.getUint16(offset + 8, true);
    const madeBy = view.getUint16(offset + 4, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const originalSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (
      (flags & 1) !== 0 ||
      ((madeBy >>> 8 === 3 || madeBy >>> 8 === 19) &&
        ((externalAttributes >>> 16) & 0o170000) === 0o120000) ||
      compressedSize === 0xffffffff ||
      originalSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      localOffset >= centralOffset ||
      originalSize > MAX_PLUGIN_FILE_BYTES ||
      next > eocd
    )
      throw new Error("PLUGIN_PACKAGE_ZIP_UNSUPPORTED");
    const path = strFromU8(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    );
    validatePath(path);
    const caseFolded = path.toLowerCase();
    if (entries.has(path) || caseFoldedPaths.has(caseFolded))
      throw new Error(`PLUGIN_PACKAGE_DUPLICATE_PATH:${path.slice(0, 120)}`);
    expandedBytes += originalSize;
    if (expandedBytes > MAX_PLUGIN_EXPANDED_BYTES)
      throw new Error("PLUGIN_PACKAGE_EXPANSION_LIMIT");
    entries.set(path, originalSize);
    caseFoldedPaths.add(caseFolded);
    offset = next;
  }
  if (offset !== eocd) throw new Error("PLUGIN_PACKAGE_ZIP_INVALID");
  return entries;
};

const parseJson = <T>(bytes: Uint8Array, schema: z.ZodType<T>): T => {
  let value: unknown;
  try {
    value = JSON.parse(strFromU8(bytes));
  } catch {
    throw new Error("PLUGIN_PACKAGE_JSON_INVALID");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("PLUGIN_PACKAGE_JSON_INVALID");
  return parsed.data;
};

export const packageFilesDigest = async (
  files: Record<string, string>,
): Promise<string> =>
  sha256(
    stableJson(
      Object.fromEntries(
        await Promise.all(
          Object.entries(files)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(async ([path, encoded]) => [
              path,
              await sha256(decodePackageFile(encoded)),
            ]),
        ),
      ),
    ),
  );

export async function parsePluginArchive(
  archive: Uint8Array,
): Promise<PluginPackageParts> {
  if (archive.byteLength === 0 || archive.byteLength > MAX_PLUGIN_PACKAGE_BYTES)
    throw new Error("PLUGIN_PACKAGE_SIZE_INVALID");
  const directory = inspectCentralDirectory(archive);
  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(archive, {
      filter(file) {
        validatePath(file.name);
        if (directory.get(file.name) !== file.originalSize)
          throw new Error("PLUGIN_PACKAGE_ZIP_INVALID");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("PLUGIN_"))
      throw error;
    throw new Error("PLUGIN_PACKAGE_ZIP_INVALID");
  }
  if (Object.keys(extracted).length !== directory.size)
    throw new Error("PLUGIN_PACKAGE_ZIP_INVALID");
  const manifestBytes = extracted["manifest.json"];
  if (!manifestBytes) throw new Error("PLUGIN_MANIFEST_MISSING");
  const manifestSource = strFromU8(manifestBytes);
  const manifest = parseJson(manifestBytes, pluginManifestSchema);
  const workerPath =
    manifest.packageFormat === 2 ? "backend/worker.mjs" : "worker.mjs";
  const workerBytes = extracted[workerPath];
  if (!workerBytes) throw new Error("PLUGIN_WORKER_MISSING");
  const workerSource = strFromU8(workerBytes);

  if (manifest.packageFormat === 2) {
    for (const resource of manifest.resources ?? []) {
      if (resource.type !== "durable_object") continue;
      const className = resource.configuration.className.replace(
        /[.*+?^${}()|[\]\\]/gu,
        "\\$&",
      );
      const directExport = new RegExp(
        `export\\s+(?:class|const|let|var|function)\\s+${className}\\b`,
        "u",
      );
      const exportList = new RegExp(
        `export\\s*\\{[^}]{0,8192}(?:\\b${className}\\b|\\b[A-Za-z_$][\\w$]*\\s+as\\s+${className}\\b)[^}]*\\}`,
        "u",
      );
      if (!directExport.test(workerSource) && !exportList.test(workerSource))
        throw new Error("PLUGIN_DURABLE_OBJECT_EXPORT_MISSING");
    }
    const integrityBytes = extracted["integrity.json"];
    const signatureBytes = extracted["signature.json"];
    if (!integrityBytes || !signatureBytes)
      throw new Error("PLUGIN_PACKAGE_TRUST_METADATA_MISSING");
    const integrity = parseJson(integrityBytes, integritySchema);
    parseJson(signatureBytes, packageSignatureSchema);
    const payloadPaths = Object.keys(extracted)
      .filter((path) => path !== "integrity.json" && path !== "signature.json")
      .sort();
    const integrityPaths = Object.keys(integrity.files).sort();
    if (stableJson(payloadPaths) !== stableJson(integrityPaths))
      throw new Error("PLUGIN_PACKAGE_INTEGRITY_INCOMPLETE");
    for (const path of payloadPaths) {
      const descriptor = integrity.files[path]!;
      if (
        extracted[path]!.byteLength !== descriptor.size ||
        (await sha256(extracted[path]!)) !== descriptor.sha256
      )
        throw new Error("PLUGIN_PACKAGE_INTEGRITY_MISMATCH");
    }
    if (!manifest.frontend || !extracted[manifest.frontend.entry])
      throw new Error("PLUGIN_FRONTEND_ENTRY_MISSING");
    for (const style of manifest.frontend.styles)
      if (!extracted[style]) throw new Error("PLUGIN_FRONTEND_STYLE_MISSING");
    const openapiBytes = extracted["openapi.json"];
    if (openapiBytes) {
      let document: unknown;
      try {
        document = JSON.parse(strFromU8(openapiBytes));
      } catch {
        throw new Error("PLUGIN_OPENAPI_INVALID");
      }
      if (!document || typeof document !== "object" || Array.isArray(document))
        throw new Error("PLUGIN_OPENAPI_INVALID");
      const openapi = (document as { openapi?: unknown }).openapi;
      const paths = (document as { paths?: unknown }).paths;
      if (
        typeof openapi !== "string" ||
        !/^3\.[01]\./u.test(openapi) ||
        !paths ||
        typeof paths !== "object" ||
        Array.isArray(paths) ||
        Object.keys(paths).length > 200
      )
        throw new Error("PLUGIN_OPENAPI_INVALID");
      const authenticatedPrefix = `/api/v1/p/${manifest.id}`;
      const publicPrefix = `/api/v1/public/p/${manifest.id}`;
      for (const path of Object.keys(paths)) {
        const authenticated =
          path === authenticatedPrefix ||
          path.startsWith(`${authenticatedPrefix}/`);
        const relativePublic = path.startsWith(publicPrefix)
          ? path.slice(publicPrefix.length) || "/"
          : null;
        const declaredPublic =
          relativePublic !== null &&
          (manifest.publicRoutes ?? []).some(
            (route) =>
              relativePublic === route ||
              relativePublic.startsWith(`${route}/`),
          );
        if (!authenticated && !declaredPublic)
          throw new Error("PLUGIN_OPENAPI_PATH_OUTSIDE_NAMESPACE");
      }
    }
  }

  const migrations = (dialect: "d1" | "postgres"): MigrationSet =>
    Object.fromEntries(
      Object.entries(extracted)
        .map(([path, bytes]) => {
          const match = migrationPath.exec(path);
          return match?.[1] === dialect
            ? ([match[2]!, strFromU8(bytes)] as const)
            : null;
        })
        .filter((entry): entry is readonly [string, string] => Boolean(entry))
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  const d1Migrations = migrations("d1");
  const postgresMigrations = migrations("postgres");
  const represented = new Set([
    "manifest.json",
    workerPath,
    ...Object.keys(extracted).filter((path) => migrationPath.test(path)),
  ]);
  const files = Object.fromEntries(
    Object.entries(extracted)
      .filter(([path]) => !represented.has(path))
      .map(([path, bytes]) => [path, encode(bytes)]),
  );
  return {
    manifest,
    manifestSource,
    worker: workerSource,
    d1Migrations,
    postgresMigrations,
    files,
    rawBytes: archive.byteLength,
    archiveSha256: await sha256(archive),
  };
}
