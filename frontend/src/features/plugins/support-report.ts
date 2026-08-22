export type PluginSupportDiagnostic = {
  operationId?: string;
  pluginId?: string;
  targetVersion?: string;
  type?: string;
  state?: string;
  failureStage?: string;
  failureReason?: string;
  failureDetail?: string;
  failureRequestId?: string;
  failedAt?: number;
};

export type PluginSupportPackage = {
  pluginId: string;
  version: string;
  rawBytes: number;
  gzipBytes: number;
  d1MigrationIds: string[];
  postgresMigrationIds: string[];
};

type ReportInput = {
  diagnostic: PluginSupportDiagnostic;
  package: PluginSupportPackage;
  clientErrorCode?: string;
  clientRequestId?: string;
  coreOrigin: string;
  generatedAt?: number;
};

const timestamp = (value: number | undefined): string => {
  const date = new Date(value ?? Date.now());
  return Number.isNaN(date.getTime()) ? "unknown" : date.toISOString();
};

const inline = (value: string, limit = 200): string =>
  value
    .replace(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, limit) || "unknown";

export const buildPluginSupportReport = ({
  diagnostic,
  package: packageSummary,
  clientErrorCode,
  clientRequestId,
  coreOrigin,
  generatedAt,
}: ReportInput): string => {
  const lines = [
    "Nexus Edge Plugin Installer Support Report",
    `Generated at: ${timestamp(generatedAt)}`,
    `Core origin: ${inline(coreOrigin)}`,
    `Operation ID: ${inline(diagnostic.operationId ?? "not-created")}`,
    `Plugin ID: ${inline(diagnostic.pluginId ?? packageSummary.pluginId)}`,
    `Plugin version: ${inline(diagnostic.targetVersion ?? packageSummary.version)}`,
    `Operation type: ${inline(diagnostic.type ?? "install")}`,
    `Operation state: ${inline(diagnostic.state ?? "failed")}`,
    `Failure stage: ${inline(diagnostic.failureStage ?? "validating")}`,
    `Failure code: ${inline(diagnostic.failureReason ?? clientErrorCode ?? "client_request_failed")}`,
    `Failure detail: ${inline(diagnostic.failureDetail ?? "The request failed before a safe server diagnostic was available.", 500)}`,
    `Failure request ID: ${inline(diagnostic.failureRequestId ?? "unavailable")}`,
    `Client request ID: ${inline(clientRequestId ?? "unavailable")}`,
    `Failed at: ${diagnostic.failedAt ? timestamp(diagnostic.failedAt) : "unavailable"}`,
    `Package raw bytes: ${packageSummary.rawBytes}`,
    `Worker gzip bytes: ${packageSummary.gzipBytes}`,
    `D1 migrations: ${inline(packageSummary.d1MigrationIds.join(", ") || "none", 500)}`,
    `PostgreSQL migrations: ${inline(packageSummary.postgresMigrationIds.join(", ") || "none", 500)}`,
    "Security note: raw provider logs, package contents, credentials, and secrets were omitted.",
  ];

  return lines.join("\n");
};
