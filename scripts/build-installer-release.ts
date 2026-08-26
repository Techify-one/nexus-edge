import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  canonicalJson,
  installerReleaseSchema,
  migrationArtifactSchema,
  splitSqlStatements,
  staticAssetContentType,
  stableReleasePointerSchema,
  workerModuleContentType,
  type InstallerRelease,
  type ReleaseAsset,
  type ReleaseObject,
} from "@app/installer-release-schema";
import { SCHEMA_VERSION } from "../packages/db-schema/src/common/index.js";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
) as { version: string };
const version = process.env.INSTALLER_RELEASE_VERSION ?? packageJson.version;
const outputRoot = resolve(
  process.env.INSTALLER_RELEASE_OUTPUT ??
    join(repositoryRoot, "installer/release-build"),
);
const releasePrefix = `releases/${version}`;
const versionRoot = join(outputRoot, releasePrefix);

const privateKeyBase64 = process.env.INSTALLER_RELEASE_PRIVATE_KEY_PKCS8_BASE64;
if (!privateKeyBase64)
  throw new Error("INSTALLER_RELEASE_PRIVATE_KEY_PKCS8_BASE64 is required");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const sourceDate = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1_000)
  : new Date(
      execFileSync("git", ["show", "-s", "--format=%cI", sourceCommit], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim(),
    );
if (Number.isNaN(sourceDate.getTime())) throw new Error("Invalid release date");
const createdAt = sourceDate.toISOString();

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

async function files(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  await visit(root);
  return output.sort();
}

async function addObjects(
  root: string,
  category: "modules" | "assets",
): Promise<Array<ReleaseObject | ReleaseAsset>> {
  const descriptors: Array<ReleaseObject | ReleaseAsset> = [];
  for (const source of await files(root)) {
    if (source.endsWith(".map") || source.endsWith(".assetsignore")) continue;
    const contentType =
      category === "modules"
        ? workerModuleContentType(source)
        : staticAssetContentType(source);
    if (!contentType) continue;
    const path = relative(root, source).replaceAll("\\", "/");
    const content = await readFile(source);
    const digest = sha256(content);
    const objectKey = `${releasePrefix}/${category}/${digest}`;
    const destination = join(outputRoot, objectKey);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(source, destination);
    const base = {
      path,
      objectKey,
      mimeType: contentType,
      size: (await stat(source)).size,
      sha256: digest,
    };
    descriptors.push(
      category === "assets"
        ? {
            ...base,
            uploadHash: sha256(
              `${content.toString("base64")}${extname(source).slice(1)}${contentType}`,
            ).slice(0, 32),
          }
        : base,
    );
  }
  return descriptors;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(versionRoot, { recursive: true });

const modules = (await addObjects(
  join(repositoryRoot, "frontend/dist/app_core"),
  "modules",
)) as ReleaseObject[];
const assets = (await addObjects(
  join(repositoryRoot, "frontend/dist/client"),
  "assets",
)) as ReleaseAsset[];

const d1Migrations = [];
for (const source of await files(
  join(repositoryRoot, "workers/core/migrations/d1"),
)) {
  if (!source.endsWith(".sql")) continue;
  const id = source
    .split("/")
    .at(-1)!
    .replace(/\.sql$/u, "");
  const sql = await readFile(source, "utf8");
  const artifact = migrationArtifactSchema.parse({
    schemaVersion: 1,
    id,
    sourceSha256: sha256(sql),
    statements: splitSqlStatements(sql),
  });
  const content = `${canonicalJson(artifact)}\n`;
  const digest = sha256(content);
  const objectKey = `${releasePrefix}/migrations/d1/${id}.json`;
  const destination = join(outputRoot, objectKey);
  await mkdir(resolve(destination, ".."), { recursive: true });
  await writeFile(destination, content);
  d1Migrations.push({
    id,
    path: `migrations/d1/${id}.json`,
    objectKey,
    mimeType: "application/json",
    size: Buffer.byteLength(content),
    sha256: digest,
    statementCount: artifact.statements.length,
  });
}

const release = installerReleaseSchema.parse({
  schemaVersion: 1,
  appVersion: version,
  sourceCommit,
  createdAt,
  compatibilityDate: "2026-08-21",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint: "index.js",
  modules,
  assets,
  d1Migrations,
  databaseSchemaVersion: SCHEMA_VERSION,
  requiredBindings: ["ASSETS", "DB", "WEBHOOK_QUEUE"],
  cron: ["* * * * *"],
  healthChecks: ["/health", "/api/v1/setup/status"],
  minimumInstallerVersion: "1.0.0",
}) satisfies InstallerRelease;
const manifestContent = canonicalJson(release);
const manifestObjectKey = `${releasePrefix}/release.json`;
await writeFile(join(outputRoot, manifestObjectKey), `${manifestContent}\n`);

const manifestDigest = createHash("sha256").update(manifestContent).digest();
const privateKey = createPrivateKey({
  key: Buffer.from(privateKeyBase64, "base64"),
  format: "der",
  type: "pkcs8",
});
if (privateKey.asymmetricKeyType !== "ed25519")
  throw new Error("Release signing key must be Ed25519");
const signatureObjectKey = `${releasePrefix}/release.sig`;
const signature = sign(null, manifestDigest, privateKey);
const publicKey = createPublicKey(privateKey);
if (!verify(null, manifestDigest, publicKey, signature))
  throw new Error("Release signature self-verification failed");
const publicKeySpkiBase64 = publicKey
  .export({
    format: "der",
    type: "spki",
  })
  .toString("base64");
const expectedPublicKey = process.env.INSTALLER_RELEASE_PUBLIC_KEY_SPKI_BASE64;
if (expectedPublicKey && expectedPublicKey !== publicKeySpkiBase64)
  throw new Error(
    "Release signing key does not match the configured public key",
  );
await writeFile(
  join(outputRoot, signatureObjectKey),
  `${signature.toString("base64")}\n`,
);

const pointer = stableReleasePointerSchema.parse({
  schemaVersion: 1,
  channel: "stable",
  version,
  manifestObjectKey,
  manifestSha256: manifestDigest.toString("hex"),
  signatureObjectKey,
  updatedAt: createdAt,
});
await writeFile(
  join(outputRoot, "releases/stable.json"),
  `${canonicalJson(pointer)}\n`,
);

process.stdout.write(
  `${JSON.stringify({
    outputRoot,
    version,
    modules: modules.length,
    assets: assets.length,
    migrations: d1Migrations.length,
    publicKeySha256: sha256(Buffer.from(publicKeySpkiBase64, "base64")),
  })}\n`,
);
