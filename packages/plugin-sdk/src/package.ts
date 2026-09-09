import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { gzipSync, strFromU8, strToU8, zipSync } from "fflate";

const packagePath =
  /^(?:manifest\.json|integrity\.json|signature\.json|openapi\.json|LICENSE|backend\/[A-Za-z0-9_.@/-]+|frontend\/[A-Za-z0-9_.@/-]+|locales\/[A-Za-z0-9_-]+\.json|resources\/[A-Za-z0-9_.@/-]+|migrations\/(?:d1|postgres)\/\d{4}_[a-z0-9_]+\.sql)$/u;

export const sha256PluginBytes = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("base64url");

const normalizeCanonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCanonical(entry)]),
    );
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  throw new TypeError("Canonical JSON accepts only finite JSON values");
};

export const canonicalPluginJson = (value: unknown): string =>
  JSON.stringify(normalizeCanonical(value));

export const validatePluginOpenApi = (
  pluginId: string,
  publicRoutes: unknown,
  bytes: Uint8Array,
): void => {
  let document: unknown;
  try {
    document = JSON.parse(strFromU8(bytes));
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
  const authenticatedPrefix = `/api/v1/p/${pluginId}`;
  const publicPrefix = `/api/v1/public/p/${pluginId}`;
  const declaredPublic = Array.isArray(publicRoutes)
    ? publicRoutes.filter((route): route is string => typeof route === "string")
    : [];
  for (const path of Object.keys(paths)) {
    const authenticated =
      path === authenticatedPrefix ||
      path.startsWith(`${authenticatedPrefix}/`);
    const relativePublic = path.startsWith(publicPrefix)
      ? path.slice(publicPrefix.length) || "/"
      : null;
    const allowedPublic =
      relativePublic !== null &&
      declaredPublic.some(
        (route) =>
          relativePublic === route || relativePublic.startsWith(`${route}/`),
      );
    if (!authenticated && !allowedPublic)
      throw new Error("PLUGIN_OPENAPI_PATH_OUTSIDE_NAMESPACE");
  }
};

const contentType = (path: string): string => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (extension === "js" || extension === "mjs")
    return "application/javascript+module";
  if (extension === "json") return "application/json";
  if (extension === "css") return "text/css";
  if (extension === "sql" || extension === "txt") return "text/plain";
  if (extension === "wasm") return "application/wasm";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "woff2") return "font/woff2";
  return "application/octet-stream";
};

const addDirectory = (
  files: Record<string, Uint8Array>,
  directory: string,
  packagePrefix: string,
): void => {
  if (!existsSync(directory)) return;
  const rootMetadata = lstatSync(directory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error(`Package input must be a regular directory: ${directory}`);
  const visit = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink())
        throw new Error(`Package input cannot be a symbolic link: ${path}`);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) {
        const destination = `${packagePrefix}/${relative(directory, path).replaceAll("\\", "/")}`;
        if (!destination.endsWith(".map"))
          files[destination] = readFileSync(path);
      } else throw new Error(`Package input must be a regular file: ${path}`);
    }
  };
  visit(directory);
};

const readRegularFile = (path: string): Buffer => {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error(`Package input must be a regular file: ${path}`);
  return readFileSync(path);
};

export type BuildPluginPackageOptions = {
  root: string;
  privateKey: string;
  keyId?: string;
  output?: string;
};

/** Build a deterministic, signed package-format-2 archive outside the Core. */
export async function buildPluginPackage(
  options: BuildPluginPackageOptions,
): Promise<string> {
  const rootMetadata = lstatSync(options.root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory())
    throw new Error("The plugin root must be a regular directory.");
  const manifestPath = join(options.root, "manifest.json");
  const manifestSource = new TextDecoder().decode(
    readRegularFile(manifestPath),
  );
  const manifest = JSON.parse(manifestSource) as {
    id?: unknown;
    packageFormat?: unknown;
    publicRoutes?: unknown;
  };
  const id = typeof manifest.id === "string" ? manifest.id : "";
  if (!/^[a-z][a-z0-9_]{1,31}$/u.test(id) || manifest.packageFormat !== 2)
    throw new Error("A valid package-format-2 manifest is required.");
  const worker = readRegularFile(join(options.root, "dist", "index.js"));
  if (gzipSync(worker).byteLength > 3 * 1024 * 1024)
    throw new Error("The compressed Worker exceeds 3 MiB.");
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(manifestSource),
    "backend/worker.mjs": worker,
  };
  for (const dialect of ["d1", "postgres"] as const) {
    const directory = join(options.root, "migrations", dialect);
    if (!existsSync(directory)) continue;
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      files[`migrations/${dialect}/${basename(file)}`] = readRegularFile(
        join(directory, file),
      );
  }
  addDirectory(files, join(options.root, "dist", "frontend"), "frontend");
  addDirectory(files, join(options.root, "backend-modules"), "backend/modules");
  addDirectory(files, join(options.root, "locales"), "locales");
  addDirectory(files, join(options.root, "resources"), "resources");
  const openApiPath = join(options.root, "openapi.json");
  if (existsSync(openApiPath)) {
    const openApi = readRegularFile(openApiPath);
    validatePluginOpenApi(id, manifest.publicRoutes, openApi);
    files["openapi.json"] = openApi;
  }
  for (const [source, destination] of [
    [join(options.root, "LICENSE"), "LICENSE"],
  ] as const)
    if (existsSync(source)) files[destination] = readRegularFile(source);
  const integrity = {
    algorithm: "sha256",
    files: Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, value]) => [
          path,
          {
            sha256: sha256PluginBytes(value),
            size: value.byteLength,
            contentType: contentType(path),
          },
        ]),
    ),
  };
  files["integrity.json"] = strToU8(`${JSON.stringify(integrity, null, 2)}\n`);
  const privateKey = createPrivateKey({
    key: Buffer.from(options.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("The plugin signing key must be Ed25519.");
  files["signature.json"] = strToU8(
    `${JSON.stringify(
      {
        algorithm: "Ed25519",
        keyId: options.keyId || "publisher-v1",
        signature: Buffer.from(
          sign(null, Buffer.from(canonicalPluginJson(integrity)), privateKey),
        ).toString("base64url"),
      },
      null,
      2,
    )}\n`,
  );
  const entries = Object.entries(files);
  if (
    entries.length > 25 ||
    entries.some(
      ([path, bytes]) =>
        !packagePath.test(path) ||
        path
          .split("/")
          .some((part) => part === "" || part === "." || part === "..") ||
        bytes.byteLength > 6 * 1024 * 1024,
    ) ||
    entries.reduce((total, [, bytes]) => total + bytes.byteLength, 0) >
      24 * 1024 * 1024
  )
    throw new Error("The plugin package exceeds the format 2 safety limits.");
  const output =
    options.output ?? join(options.root, "release", `${id}.plugin.zip`);
  mkdirSync(dirname(output), { recursive: true });
  if (existsSync(output)) {
    const outputMetadata = lstatSync(output);
    if (outputMetadata.isSymbolicLink() || !outputMetadata.isFile())
      throw new Error("The package output must be a regular file.");
  }
  const archive = zipSync(files, {
    level: 9,
    mtime: new Date(2000, 0, 1, 0, 0, 0),
    os: 3,
    attrs: 0o644 << 16,
  });
  if (archive.byteLength > 8 * 1024 * 1024)
    throw new Error("The plugin package exceeds the 8 MiB archive limit.");
  writeFileSync(output, archive);
  return output;
}
