import { gzipSync, strFromU8, unzipSync } from "fflate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Download,
  ExternalLink,
  PackagePlus,
  Pencil,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../components/ui/configurable-data-table.js";
import { Modal } from "../../components/ui/modal.js";
import {
  Badge,
  Button,
  Input,
  Label,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.js";
import {
  ApiError,
  api,
  apiFile,
  idempotencyKey,
  recentReauthHeaders,
} from "../../lib/api/core-client.js";
import {
  cloudflareAccountTokensUrl,
  cloudflarePluginTokenTemplateUrl,
  cloudflareR2TokenTemplateUrl,
} from "../../lib/cloudflare-token.js";
import { translate, useI18n, type TranslationKey } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";
import {
  buildPluginSupportReport,
  type PluginSupportDiagnostic,
} from "./support-report.js";
import { MarketplacePanels } from "./MarketplacePanels.js";

type Manifest = {
  id: string;
  name: string;
  version: string;
  coreMinVersion: string;
  permissions: string[];
  menu: { title: string; routeKey: string }[];
  runtimeBindings?: Array<"ai" | "r2">;
  optionalRuntimeBindings?: Array<"ai" | "r2">;
  databaseDialects: Array<"d1" | "postgres">;
  packageFormat?: 2;
  resources?: Array<{
    name: string;
    type: "database" | "r2" | "kv" | "queue" | "durable_object" | "cron" | "ai";
    binding: string;
    required: boolean;
  }>;
};
type Plugin = {
  id: string;
  name: string;
  installedVersion: string;
  apiVersion: number;
  databaseProvider: string;
  workerName: string;
  status: string;
  runtimeStorageStatus?: string | null;
  installedAt: string | number;
  packageAvailable: boolean | number;
};
type Operation = {
  operationId: string;
  state: string;
};
type OperationResource = {
  logicalName: string;
  type: "database" | "r2" | "kv" | "queue" | "durable_object" | "cron" | "ai";
  binding: string;
  required: boolean;
  status: string;
};
type RuntimeResources = {
  items: Array<{
    logicalName: string;
    type: OperationResource["type"];
    required: boolean;
    status: string;
    configured: boolean;
  }>;
};
type PluginRuntimeCredential = {
  configured: boolean;
  accountId: string;
};
type PluginParts = {
  manifest: Manifest;
  manifestText: string;
  worker: Uint8Array;
  d1Migrations: Record<string, string>;
  postgresMigrations: Record<string, string>;
  rawBytes: number;
  gzipBytes: number;
  file: File;
  sourceReleaseId?: string;
};

type PluginTab = "installed" | "catalog" | "marketplaces";

function RuntimeCredentialGuide({
  accountId,
  inputId,
  token,
  onTokenChange,
}: {
  accountId: string;
  inputId: string;
  token: string;
  onTokenChange: (token: string) => void;
}) {
  const { t } = useI18n();
  return (
    <section className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm">
      <a
        className="inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700 sm:w-auto"
        href={cloudflarePluginTokenTemplateUrl(accountId)}
        target="_blank"
        rel="noreferrer noopener"
      >
        {t("plugins.runtimeCredentialCreate")}
        <ExternalLink className="h-4 w-4" />
      </a>
      <ol className="list-decimal space-y-3 pl-5 text-slate-800">
        <li>{t("plugins.runtimeCredentialStepOpen")}</li>
        <li>
          {t("plugins.runtimeCredentialStepReview")}{" "}
          <strong>Account → Workers Scripts → Edit</strong>
        </li>
        <li>{t("plugins.runtimeCredentialStepCreateToken")}</li>
        <li>{t("plugins.runtimeCredentialStepPaste")}</li>
      </ol>
      <div className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-xs text-slate-600">
        <span className="font-semibold text-slate-800">
          {t("plugins.runtimeCredentialTargetAccount")}
        </span>{" "}
        <code className="break-all">{accountId}</code>
      </div>
      <p className="border-l-4 border-amber-400 bg-amber-50 px-3 py-2 text-amber-900">
        {t("plugins.runtimeCredentialWarning")}
      </p>
      <div className="space-y-2">
        <Label htmlFor={inputId}>{t("plugins.runtimeCredentialLabel")}</Label>
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          minLength={40}
          maxLength={2048}
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          placeholder={t("plugins.runtimeCredentialPlaceholder")}
          required
        />
        <p className="text-xs text-slate-600">
          {t("plugins.runtimeCredentialHelp")}
        </p>
        <a
          className="inline-flex items-center gap-1 text-xs font-medium text-indigo-700 underline underline-offset-2"
          href={cloudflareAccountTokensUrl(accountId)}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t("plugins.runtimeCredentialOpenList")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>
    </section>
  );
}

const states = [
  "validating",
  "provisioning",
  "migrating",
  "deploying",
  "hardening",
  "binding",
  "registering",
  "installed",
];
const terminal = new Set(["installed", "failed"]);
const stateKeys: Record<string, TranslationKey> = {
  validating: "plugins.state.validating",
  provisioning: "plugins.state.provisioning",
  migrating: "plugins.state.migrating",
  deploying: "plugins.state.deploying",
  hardening: "plugins.state.hardening",
  binding: "plugins.state.binding",
  registering: "plugins.state.registering",
  installed: "plugins.state.installed",
  failed: "plugins.state.failed",
};

async function readPlugin(file: File): Promise<PluginParts> {
  if (!file.name.endsWith(".plugin.zip"))
    throw new Error(translate("plugins.selectPackage"));
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024)
    throw new Error(translate("plugins.rawTooLarge"));
  let expandedBytes = 0;
  let fileCount = 0;
  const files = unzipSync(bytes, {
    filter(entry) {
      fileCount += 1;
      expandedBytes += entry.originalSize;
      if (
        fileCount > 25 ||
        entry.originalSize > 6 * 1024 * 1024 ||
        expandedBytes > 24 * 1024 * 1024
      )
        throw new Error(translate("plugins.expansionTooLarge"));
      return true;
    },
  });
  const manifestBytes = files["manifest.json"];
  const worker = files["backend/worker.mjs"] ?? files["worker.mjs"];
  if (!manifestBytes || !worker)
    throw new Error(translate("plugins.packageContents"));
  const manifestText = strFromU8(manifestBytes);
  const manifest = JSON.parse(manifestText) as Manifest;
  const migrations = (dialect: "d1" | "postgres") =>
    Object.fromEntries(
      Object.entries(files)
        .filter(
          ([name]) =>
            name.startsWith(`migrations/${dialect}/`) && name.endsWith(".sql"),
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => [
          name
            .split("/")
            .at(-1)!
            .replace(/\.sql$/u, ""),
          strFromU8(value),
        ]),
    );
  const d1Migrations = migrations("d1");
  const postgresMigrations = migrations("postgres");
  const supportsD1 = manifest.databaseDialects?.includes("d1");
  const supportsPostgres = manifest.databaseDialects?.includes("postgres");
  if (
    (supportsD1 && !Object.keys(d1Migrations).length) ||
    (supportsPostgres && !Object.keys(postgresMigrations).length) ||
    (!supportsD1 && Object.keys(d1Migrations).length > 0) ||
    (!supportsPostgres && Object.keys(postgresMigrations).length > 0) ||
    (supportsD1 &&
      supportsPostgres &&
      JSON.stringify(Object.keys(d1Migrations)) !==
        JSON.stringify(Object.keys(postgresMigrations)))
  )
    throw new Error(translate("plugins.migrationPairs"));
  const rawBytes = bytes.byteLength;
  return {
    manifest,
    manifestText,
    worker,
    d1Migrations,
    postgresMigrations,
    rawBytes,
    gzipBytes: gzipSync(worker).byteLength,
    file,
  };
}

const bodyFor = (parts: PluginParts) => {
  const form = new FormData();
  form.set("package", parts.file);
  if (parts.sourceReleaseId) form.set("sourceReleaseId", parts.sourceReleaseId);
  return form;
};

export default function PluginsPage() {
  const { t } = useI18n();
  const canCreate = can("core.plugin.create");
  const canUpdate = can("core.plugin.update");
  const canDelete = can("core.plugin.delete");
  const canExport = can("core.plugin.export");
  const stateLabel = (state: string) =>
    stateKeys[state] ? t(stateKeys[state]) : state;
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const archiveTargetRef = useRef<Plugin | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<PluginTab>("installed");
  const [selected, setSelected] = useState<Plugin | null>(null);
  const [parts, setParts] = useState<PluginParts | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [supportReport, setSupportReport] = useState<string | null>(null);
  const [runtimeToken, setRuntimeToken] = useState("");
  const [r2Token, setR2Token] = useState("");
  const [runtimeCredentialBusy, setRuntimeCredentialBusy] = useState(false);
  const [runtimeCredentialSetupOpen, setRuntimeCredentialSetupOpen] =
    useState(false);
  const runtimeCredentialPrompted = useRef(false);
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => api<{ items: Plugin[] }>("/api/v1/plugins"),
  });
  const requiresR2Provisioning = (manifest: Manifest): boolean =>
    Boolean(
      manifest.runtimeBindings?.includes("r2") &&
      (plugins.data?.items ?? []).find((plugin) => plugin.id === manifest.id)
        ?.runtimeStorageStatus !== "ready",
    );
  const requiredExternalResources = (manifest: Manifest) =>
    (manifest.resources ?? []).filter(
      (resource) =>
        resource.required && ["r2", "kv", "queue"].includes(resource.type),
    );
  const requiresResourceProvisioning = (manifest: Manifest): boolean =>
    requiredExternalResources(manifest).length > 0;
  const selectedInstalledPlugin = parts
    ? (plugins.data?.items ?? []).find(
        (plugin) =>
          plugin.id === parts.manifest.id && plugin.status === "installed",
      )
    : undefined;
  const installedRuntimeResources = useQuery({
    queryKey: ["plugin-runtime-resources", parts?.manifest.id],
    queryFn: () =>
      api<RuntimeResources>(
        `/api/v1/plugins/${encodeURIComponent(parts!.manifest.id)}/runtime-resources`,
      ),
    enabled: Boolean(
      parts &&
      selectedInstalledPlugin &&
      requiresResourceProvisioning(parts.manifest),
    ),
  });
  const requiresResourceToken = parts
    ? requiredExternalResources(parts.manifest).some(
        (declaration) =>
          !selectedInstalledPlugin ||
          !installedRuntimeResources.data?.items.some(
            (resource) =>
              resource.logicalName === declaration.name &&
              resource.type === declaration.type &&
              resource.configured,
          ),
      )
    : false;
  const runtimeCredential = useQuery({
    queryKey: ["plugin-runtime-credential"],
    queryFn: () =>
      api<PluginRuntimeCredential>("/api/v1/plugin-runtime-credential"),
    enabled: canCreate || canUpdate,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (runtimeCredential.data?.configured) {
      setRuntimeCredentialSetupOpen(false);
      return;
    }
    if (
      canCreate &&
      runtimeCredential.data &&
      !runtimeCredentialPrompted.current
    ) {
      runtimeCredentialPrompted.current = true;
      setRuntimeCredentialSetupOpen(true);
    }
  }, [canCreate, runtimeCredential.data]);
  const rows = useMemo(
    () =>
      (plugins.data?.items ?? []).filter((plugin) =>
        `${plugin.name} ${plugin.id}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [plugins.data, search],
  );
  const choose = async (file?: File, sourceReleaseId?: string) => {
    if (!file) return;
    try {
      const selectedParts = await readPlugin(file);
      const operationType = (plugins.data?.items ?? []).some(
        (plugin) =>
          plugin.id === selectedParts.manifest.id &&
          plugin.status === "installed",
      )
        ? "update"
        : "install";
      if (
        (operationType === "update" && !canUpdate) ||
        (operationType === "install" && !canCreate)
      )
        throw new Error(t("plugins.permissionRequired"));
      setParts({
        ...selectedParts,
        ...(sourceReleaseId ? { sourceReleaseId } : {}),
      });
      setOperation(null);
      setSupportReport(null);
      setRuntimeToken("");
      setR2Token("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("plugins.invalidPackage"),
      );
    }
  };
  const install = useMutation({
    mutationFn: async (packageParts: PluginParts) => {
      setSupportReport(null);
      let current: Operation | null = null;
      const requiredResources = requiredExternalResources(
        packageParts.manifest,
      );
      const installedPlugin = (plugins.data?.items ?? []).find(
        (plugin) =>
          plugin.id === packageParts.manifest.id &&
          plugin.status === "installed",
      );
      const existingResources =
        installedPlugin && requiredResources.length > 0
          ? await api<RuntimeResources>(
              `/api/v1/plugins/${encodeURIComponent(packageParts.manifest.id)}/runtime-resources`,
            )
          : null;
      const requiresGenericResources = requiredResources.some(
        (declaration) =>
          !existingResources?.items.some(
            (resource) =>
              resource.logicalName === declaration.name &&
              resource.type === declaration.type &&
              resource.configured,
          ),
      );
      const requiresR2 =
        !requiresGenericResources &&
        requiresR2Provisioning(packageParts.manifest);
      const requiresProvisioning = requiresGenericResources || requiresR2;
      const temporaryR2Token = r2Token.trim();
      try {
        if (packageParts.rawBytes > 8 * 1024 * 1024)
          throw new Error(t("plugins.rawTooLarge"));
        if (packageParts.gzipBytes > 3 * 1024 * 1024)
          throw new Error(t("plugins.gzipTooLarge"));
        if (requiresProvisioning && temporaryR2Token.length < 40)
          throw new Error(t("plugins.resourceTokenRequired"));
        const r2Reauth = requiresProvisioning
          ? await recentReauthHeaders(t("plugins.resourceReauthPassword"))
          : {};
        current = await api<Operation>("/api/v1/plugin-operations", {
          method: "POST",
          headers: {
            "Idempotency-Key": idempotencyKey(),
          },
          body: bodyFor(packageParts),
        });
        setOperation(current);
        while (!terminal.has(current.state)) {
          if (current.state === "provisioning") {
            if (temporaryR2Token.length < 40)
              throw new Error(t("plugins.resourceTokenRequired"));
            if (requiresGenericResources) {
              const resourcePlan: { items: OperationResource[] } = await api<{
                items: OperationResource[];
              }>(`/api/v1/plugin-operations/${current.operationId}/resources`);
              const nextResource: OperationResource | undefined =
                resourcePlan.items.find(
                  (resource: OperationResource) =>
                    resource.required &&
                    resource.status !== "ready" &&
                    ["r2", "kv", "queue"].includes(resource.type),
                );
              if (!nextResource)
                throw new Error(t("plugins.resourcePlanInvalid"));
              current = await api<Operation>(
                `/api/v1/plugin-operations/${current.operationId}/resources/${encodeURIComponent(nextResource.logicalName)}/provision`,
                {
                  method: "POST",
                  headers: {
                    ...r2Reauth,
                    "Idempotency-Key": `resource-${current.operationId}-${nextResource.logicalName}`,
                  },
                  body: JSON.stringify({
                    token: temporaryR2Token,
                    mode: "create",
                  }),
                },
              );
            } else {
              current = await api<Operation>(
                `/api/v1/plugin-operations/${current.operationId}/provision-r2`,
                {
                  method: "POST",
                  headers: {
                    ...r2Reauth,
                    "Idempotency-Key": `r2-${current.operationId}`,
                  },
                  body: JSON.stringify({
                    token: temporaryR2Token,
                    mode: "create",
                  }),
                },
              );
            }
            setOperation(current);
            continue;
          }
          if (current.state === "registering")
            await new Promise((resolve) => setTimeout(resolve, 3_000));
          current = await api<Operation>(
            `/api/v1/plugin-operations/${current.operationId}/advance`,
            {
              method: "POST",
              body: bodyFor(packageParts),
            },
          );
          setOperation(current);
        }
        if (current.state === "failed")
          throw new Error(t("plugins.installFailed"));
        return current;
      } catch (error) {
        setR2Token("");
        const operationType = (plugins.data?.items ?? []).some(
          (plugin) =>
            plugin.id === packageParts.manifest.id &&
            plugin.status === "installed",
        )
          ? "update"
          : "install";
        let diagnostic: PluginSupportDiagnostic = {
          ...(current ? { operationId: current.operationId } : {}),
          pluginId: packageParts.manifest.id,
          targetVersion: packageParts.manifest.version,
          type: operationType,
          state: "failed",
          failureStage: current?.state ?? "validating",
        };
        if (current?.operationId) {
          try {
            diagnostic = await api<PluginSupportDiagnostic>(
              `/api/v1/plugin-operations/${current.operationId}`,
            );
          } catch {
            // Keep the local safe fallback when diagnostics cannot be fetched.
          }
        }
        setSupportReport(
          buildPluginSupportReport({
            diagnostic,
            package: {
              pluginId: packageParts.manifest.id,
              version: packageParts.manifest.version,
              rawBytes: packageParts.rawBytes,
              gzipBytes: packageParts.gzipBytes,
              d1MigrationIds: Object.keys(packageParts.d1Migrations),
              postgresMigrationIds: Object.keys(
                packageParts.postgresMigrations,
              ),
            },
            clientErrorCode:
              error instanceof ApiError
                ? error.code
                : "client_validation_failed",
            ...(error instanceof ApiError && error.requestId
              ? { clientRequestId: error.requestId }
              : {}),
            coreOrigin: window.location.origin,
          }),
        );
        throw error;
      }
    },
    onSuccess: () => {
      toast.success(t("plugins.installed"));
      setParts(null);
      setOperation(null);
      setSupportReport(null);
      setR2Token("");
      void client.invalidateQueries({ queryKey: ["plugins"] });
      void client.invalidateQueries({ queryKey: ["plugin-runtime"] });
      void client.invalidateQueries({ queryKey: ["plugin-catalog"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
      void client.invalidateQueries({
        queryKey: ["me", "plugin-navigation"],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });
  const configureRuntimeCredential = async (
    packageParts?: PluginParts,
  ): Promise<void> => {
    if (runtimeCredentialBusy) return;
    const token = runtimeToken.trim();
    setRuntimeToken("");
    setRuntimeCredentialBusy(true);
    try {
      await api<PluginRuntimeCredential>("/api/v1/plugin-runtime-credential", {
        method: "PUT",
        body: JSON.stringify({ token }),
      });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const status = await api<PluginRuntimeCredential>(
            "/api/v1/plugin-runtime-credential",
          );
          if (status.configured) {
            client.setQueryData(["plugin-runtime-credential"], status);
            setRuntimeCredentialSetupOpen(false);
            toast.success(
              t(
                packageParts
                  ? "plugins.runtimeCredentialSavedAndInstalling"
                  : "plugins.runtimeCredentialSaved",
              ),
            );
            if (packageParts) install.mutate(packageParts);
            return;
          }
        } catch {
          // A secret update publishes a new Worker version. Retry while the
          // new version becomes active, without ever retaining the token.
        }
      }
      throw new Error(t("plugins.runtimeCredentialActivationPending"));
    } catch (error) {
      void client.invalidateQueries({
        queryKey: ["plugin-runtime-credential"],
      });
      toast.error(
        error instanceof Error ? error.message : t("errors.fallback"),
      );
    } finally {
      setRuntimeCredentialBusy(false);
    }
  };
  const remove = useMutation({
    mutationFn: (plugin: Plugin) =>
      api(`/api/v1/plugins/${plugin.id}`, { method: "DELETE" }),
    onSuccess: (_result, plugin) => {
      toast.success(
        t(
          plugin.status === "uninstalled"
            ? "plugins.recordDeleted"
            : "plugins.uninstalled",
        ),
      );
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["plugins"] });
      void client.invalidateQueries({ queryKey: ["plugin-runtime"] });
      void client.invalidateQueries({ queryKey: ["plugin-catalog"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
      void client.invalidateQueries({
        queryKey: ["me", "plugin-navigation"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const downloadPackage = useMutation({
    mutationFn: async (plugin: Plugin) => ({
      plugin,
      blob: await apiFile(
        `/api/v1/plugins/${encodeURIComponent(plugin.id)}/package`,
      ),
    }),
    onSuccess: ({ plugin, blob }) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${plugin.id}-${plugin.installedVersion}.plugin.zip`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast.success(t("plugins.packageDownloaded"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const archivePackage = useMutation({
    mutationFn: async ({ plugin, file }: { plugin: Plugin; file: File }) => {
      const packageParts = await readPlugin(file);
      if (
        packageParts.manifest.id !== plugin.id ||
        packageParts.manifest.version !== plugin.installedVersion
      )
        throw new Error(t("plugins.archivePackageMismatch"));
      await api<void>(
        `/api/v1/plugins/${encodeURIComponent(plugin.id)}/package`,
        { method: "POST", body: bodyFor(packageParts) },
      );
      return plugin;
    },
    onSuccess: (plugin) => {
      void client.invalidateQueries({ queryKey: ["plugins"] });
      setSelected((current) =>
        current?.id === plugin.id
          ? { ...current, packageAvailable: true }
          : current,
      );
      downloadPackage.mutate({ ...plugin, packageAvailable: true });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const requestPackageDownload = (plugin: Plugin) => {
    if (Boolean(plugin.packageAvailable)) {
      downloadPackage.mutate(plugin);
      return;
    }
    archiveTargetRef.current = plugin;
    toast.info(t("plugins.selectOriginalPackage"));
    archiveInputRef.current?.click();
  };
  return (
    <>
      <PageHeader
        title={t("nav.plugins")}
        description={t("plugins.description")}
        action={
          activeTab === "installed" && (canCreate || canUpdate) ? (
            <Button
              onClick={() => {
                setOperation(null);
                setSupportReport(null);
                inputRef.current?.click();
              }}
            >
              <PackagePlus className="h-4 w-4" />
              {t("common.add")}
            </Button>
          ) : undefined
        }
      />
      <div
        className="mb-6 flex gap-1 overflow-x-auto border-b"
        role="tablist"
        aria-label={t("plugins.tabs.label")}
      >
        {(["installed", "catalog", "marketplaces"] as const).map((tab) => (
          <button
            key={tab}
            id={`plugins-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`plugins-panel-${tab}`}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm font-semibold transition ${
              activeTab === tab
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {t(`plugins.tabs.${tab}`)}
          </button>
        ))}
      </div>
      {activeTab !== "installed" && (
        <section
          id={`plugins-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`plugins-tab-${activeTab}`}
        >
          <MarketplacePanels onSelectPackage={choose} view={activeTab} />
        </section>
      )}
      <section
        id="plugins-panel-installed"
        role="tabpanel"
        aria-labelledby="plugins-tab-installed"
        className="space-y-4"
        hidden={activeTab !== "installed"}
      >
        <h2 id="installed-plugins-heading" className="text-lg font-semibold">
          {t("plugins.installedSection")}
        </h2>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,.plugin.zip"
          className="hidden"
          onChange={(event) => void choose(event.target.files?.[0])}
        />
        <Modal
          open={
            runtimeCredentialSetupOpen &&
            Boolean(
              runtimeCredential.data && !runtimeCredential.data.configured,
            )
          }
          onOpenChange={(open) => {
            if (!runtimeCredentialBusy) {
              setRuntimeCredentialSetupOpen(open);
              if (!open) setRuntimeToken("");
            }
          }}
          title={t("plugins.runtimeCredentialTitle")}
          description={t("plugins.runtimeCredentialBody")}
          contentClassName="sm:max-w-2xl"
        >
          {runtimeCredential.data && !runtimeCredential.data.configured && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void configureRuntimeCredential();
              }}
            >
              <RuntimeCredentialGuide
                accountId={runtimeCredential.data.accountId}
                inputId="plugin-runtime-token-setup"
                token={runtimeToken}
                onTokenChange={setRuntimeToken}
              />
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={runtimeCredentialBusy}
                  onClick={() => {
                    setRuntimeCredentialSetupOpen(false);
                    setRuntimeToken("");
                  }}
                >
                  {t("plugins.runtimeCredentialLater")}
                </Button>
                <Button
                  busy={runtimeCredentialBusy}
                  disabled={
                    runtimeCredentialBusy || runtimeToken.trim().length < 40
                  }
                >
                  <UploadCloud className="h-4 w-4" />
                  {t("plugins.runtimeCredentialSave")}
                </Button>
              </div>
            </form>
          )}
        </Modal>
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,.plugin.zip"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            const plugin = archiveTargetRef.current;
            event.target.value = "";
            if (file && plugin) archivePackage.mutate({ plugin, file });
          }}
        />
        <div className="relative mb-4 max-w-md">
          <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-10"
            placeholder={t("plugins.search")}
            aria-label={t("plugins.search")}
          />
        </div>
        {plugins.isPending ? (
          <Skeleton className="h-72" />
        ) : (
          <ConfigurableDataTable
            tableId="core.plugins"
            rows={rows}
            onOpen={setSelected}
            columns={[
              {
                key: "name",
                label: t("common.name"),
                size: 260,
                minSize: 140,
                maxSize: 600,
                sortValue: (row) => row.name,
                render: (row) => (
                  <span className="font-medium">{row.name}</span>
                ),
              },
              {
                key: "version",
                label: t("common.version"),
                size: 140,
                minSize: 96,
                maxSize: 240,
                sortValue: (row) => row.installedVersion,
                render: (row) => row.installedVersion,
              },
              {
                key: "provider",
                label: t("plugins.database"),
                size: 140,
                minSize: 96,
                maxSize: 240,
                sortValue: (row) => row.databaseProvider,
                render: (row) => row.databaseProvider,
              },
              {
                key: "worker",
                label: t("plugins.worker"),
                size: 280,
                minSize: 160,
                maxSize: 600,
                sortValue: (row) => row.workerName,
                render: (row) => <code>{row.workerName}</code>,
              },
              {
                key: "status",
                label: t("common.status"),
                size: 160,
                minSize: 110,
                maxSize: 280,
                sortValue: (row) => row.status,
                render: (row) => (
                  <Badge
                    tone={row.status === "installed" ? "success" : "warning"}
                  >
                    {stateLabel(row.status)}
                  </Badge>
                ),
              },
            ]}
            actions={
              canExport || canUpdate || canDelete
                ? (row) => (
                    <div className="flex justify-end gap-1">
                      {canExport && row.status === "installed" && (
                        <Button
                          variant="ghost"
                          className="px-2"
                          disabled={
                            downloadPackage.isPending ||
                            archivePackage.isPending
                          }
                          onClick={() => requestPackageDownload(row)}
                          aria-label={`${t("plugins.downloadPackage")} ${row.name}`}
                          title={
                            Boolean(row.packageAvailable)
                              ? t("plugins.downloadPackage")
                              : t("plugins.downloadUnavailable")
                          }
                        >
                          <Download className="h-4 w-4" />
                        </Button>
                      )}
                      {canUpdate && row.status === "installed" && (
                        <Button
                          variant="ghost"
                          className="px-2"
                          onClick={() => setSelected(row)}
                          aria-label={`${t("common.edit")} ${row.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          className="px-2 text-red-600"
                          onClick={() =>
                            confirm(
                              t(
                                row.status === "uninstalled"
                                  ? "plugins.deleteRecordConfirm"
                                  : "plugins.uninstallConfirm",
                                {
                                  name: row.name,
                                  version: row.installedVersion,
                                },
                              ),
                            ) && remove.mutate(row)
                          }
                          aria-label={`${t(
                            row.status === "uninstalled"
                              ? "common.delete"
                              : "plugins.uninstall",
                          )} ${row.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  )
                : undefined
            }
          />
        )}
      </section>
      <Modal
        open={Boolean(parts)}
        onOpenChange={(open) => {
          if (!open && !install.isPending && !runtimeCredentialBusy) {
            setParts(null);
            setOperation(null);
            setSupportReport(null);
            setRuntimeToken("");
            setR2Token("");
          }
        }}
        title={t("plugins.installTitle")}
        description={
          parts ? `${parts.manifest.name} ${parts.manifest.version}` : undefined
        }
      >
        {parts && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (runtimeCredential.data?.configured) install.mutate(parts);
              else if (runtimeCredential.data)
                void configureRuntimeCredential(parts);
            }}
          >
            <div className="grid gap-3 rounded-xl border bg-slate-50 p-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-slate-500">ID</span>
                <p className="font-medium">{parts.manifest.id}</p>
              </div>
              <div>
                <span className="text-slate-500">
                  {t("plugins.minimumCore")}
                </span>
                <p>{parts.manifest.coreMinVersion}</p>
              </div>
              <div>
                <span className="text-slate-500">{t("plugins.rawSize")}</span>
                <p>{(parts.rawBytes / 1024).toFixed(1)} KiB</p>
              </div>
              <div>
                <span className="text-slate-500">Worker gzip</span>
                <p>{(parts.gzipBytes / 1024).toFixed(1)} KiB</p>
              </div>
              <div>
                <span className="text-slate-500">
                  {t("plugins.migrations")}
                </span>
                <p>{Object.keys(parts.d1Migrations).join(", ")}</p>
              </div>
              <div>
                <span className="text-slate-500">
                  {t("plugins.permissions")}
                </span>
                <p>{parts.manifest.permissions.length}</p>
              </div>
            </div>
            {runtimeCredential.isPending && <Skeleton className="h-36" />}
            {runtimeCredential.isError && (
              <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
                <p>{t("plugins.runtimeCredentialLoadFailed")}</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => void runtimeCredential.refetch()}
                >
                  {t("plugins.runtimeCredentialRetry")}
                </Button>
              </div>
            )}
            {runtimeCredential.data && !runtimeCredential.data.configured && (
              <RuntimeCredentialGuide
                accountId={runtimeCredential.data.accountId}
                inputId="plugin-runtime-token-install"
                token={runtimeToken}
                onTokenChange={setRuntimeToken}
              />
            )}
            {(requiresR2Provisioning(parts.manifest) ||
              requiresResourceToken) && (
              <section className="space-y-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm">
                <h3 className="font-semibold text-slate-900">
                  {requiresResourceToken
                    ? t("plugins.resourceProvisioningTitle")
                    : t("plugins.r2ProvisioningTitle")}
                </h3>
                <p className="text-slate-700">
                  {requiresResourceToken
                    ? t("plugins.resourceProvisioningDescription")
                    : t("plugins.r2ProvisioningDescription")}
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-slate-700">
                  <li>
                    {t(
                      requiresResourceToken
                        ? "plugins.resourceProvisioningStepPermission"
                        : "plugins.r2ProvisioningStepPermission",
                    )}
                  </li>
                  <li>
                    {t(
                      requiresResourceToken
                        ? "plugins.resourceProvisioningStepPaste"
                        : "plugins.r2ProvisioningStepPaste",
                    )}
                  </li>
                  <li>
                    {t(
                      requiresResourceToken
                        ? "plugins.resourceProvisioningStepRevoke"
                        : "plugins.r2ProvisioningStepRevoke",
                    )}
                  </li>
                </ol>
                {runtimeCredential.data?.accountId && (
                  <a
                    className="inline-flex items-center gap-1 font-medium text-indigo-700 underline"
                    href={
                      requiredExternalResources(parts.manifest).every(
                        (resource) => resource.type === "r2",
                      )
                        ? cloudflareR2TokenTemplateUrl(
                            runtimeCredential.data.accountId,
                          )
                        : cloudflareAccountTokensUrl(
                            runtimeCredential.data.accountId,
                          )
                    }
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("plugins.resourceOpenTokens")}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <div>
                  <Label htmlFor="plugin-r2-token">
                    {t("plugins.resourceTokenLabel")}
                  </Label>
                  <Input
                    id="plugin-r2-token"
                    type="password"
                    autoComplete="off"
                    minLength={40}
                    maxLength={2048}
                    value={r2Token}
                    onChange={(event) => setR2Token(event.target.value)}
                    placeholder={t("plugins.resourceTokenPlaceholder")}
                    required
                  />
                </div>
                <p className="text-xs text-slate-600">
                  {t("plugins.resourceTokenPrivacy")}
                </p>
              </section>
            )}
            {operation && (
              <div className="rounded-xl border p-4" aria-live="polite">
                <p className="text-sm font-semibold">
                  {t("plugins.operation", { id: operation.operationId })}
                </p>
                <ol className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                  {states.map((state) => (
                    <li
                      key={state}
                      className={`rounded-lg p-2 ${state === operation.state ? "bg-indigo-600 text-white" : states.indexOf(state) < states.indexOf(operation.state) ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
                    >
                      {stateLabel(state)}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {supportReport && (
              <details
                open
                aria-live="polite"
                className="rounded-xl border border-red-200 bg-red-50 p-4"
              >
                <summary className="cursor-pointer text-sm font-semibold text-red-900">
                  {t("plugins.supportReport")}
                </summary>
                <p className="mt-2 text-sm text-red-800">
                  {t("plugins.supportReportHelp")}
                </p>
                <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
                  {supportReport}
                </pre>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(supportReport)
                      .then(() =>
                        toast.success(t("plugins.supportReportCopied")),
                      )
                      .catch(() =>
                        toast.error(t("plugins.supportReportCopyFailed")),
                      );
                  }}
                >
                  <Copy className="h-4 w-4" />
                  {t("plugins.copySupportReport")}
                </Button>
              </details>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={install.isPending || runtimeCredentialBusy}
                onClick={() => {
                  setParts(null);
                  setOperation(null);
                  setSupportReport(null);
                  setRuntimeToken("");
                  setR2Token("");
                }}
              >
                {t("common.cancel")}
              </Button>
              <Button
                busy={install.isPending || runtimeCredentialBusy}
                disabled={
                  runtimeCredential.isPending ||
                  runtimeCredential.isError ||
                  runtimeCredentialBusy ||
                  ((requiresR2Provisioning(parts.manifest) ||
                    requiresResourceToken) &&
                    r2Token.trim().length < 40)
                }
              >
                <UploadCloud className="h-4 w-4" />
                {runtimeCredential.data?.configured
                  ? rows.some(
                      (row) =>
                        row.id === parts.manifest.id &&
                        row.status === "installed",
                    )
                    ? t("plugins.update")
                    : t("plugins.install")
                  : t("plugins.runtimeCredentialContinue")}
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected?.name ?? "Plugin"}
        description={
          selected ? `${selected.id} · ${selected.installedVersion}` : undefined
        }
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Worker</dt>
                <dd className="font-mono">{selected.workerName}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("plugins.provider")}</dt>
                <dd>{selected.databaseProvider}</dd>
              </div>
              <div>
                <dt className="text-slate-500">API</dt>
                <dd>v{selected.apiVersion}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("common.status")}</dt>
                <dd>{stateLabel(selected.status)}</dd>
              </div>
            </dl>
            <div className="flex justify-end gap-2">
              {canExport && selected.status === "installed" && (
                <Button
                  variant="secondary"
                  busy={downloadPackage.isPending || archivePackage.isPending}
                  title={
                    Boolean(selected.packageAvailable)
                      ? t("plugins.downloadPackage")
                      : t("plugins.downloadUnavailable")
                  }
                  onClick={() => requestPackageDownload(selected)}
                >
                  <Download className="h-4 w-4" />
                  {t("plugins.downloadPackage")}
                </Button>
              )}
              {canUpdate && selected.status === "installed" && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelected(null);
                    setSupportReport(null);
                    inputRef.current?.click();
                  }}
                >
                  <Pencil className="h-4 w-4" />
                  {t("plugins.update")}
                </Button>
              )}
              {canDelete && (
                <Button
                  variant="danger"
                  onClick={() =>
                    confirm(
                      t(
                        selected.status === "uninstalled"
                          ? "plugins.deleteRecordConfirm"
                          : "plugins.uninstallConfirm",
                        {
                          name: selected.name,
                          version: selected.installedVersion,
                        },
                      ),
                    ) && remove.mutate(selected)
                  }
                >
                  <Trash2 className="h-4 w-4" />
                  {t(
                    selected.status === "uninstalled"
                      ? "common.delete"
                      : "plugins.uninstall",
                  )}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
