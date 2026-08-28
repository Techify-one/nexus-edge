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
  cloudflareUserTokensUrl,
} from "../../lib/cloudflare-token.js";
import { translate, useI18n, type TranslationKey } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";
import {
  buildPluginSupportReport,
  type PluginSupportDiagnostic,
} from "./support-report.js";

type Manifest = {
  id: string;
  name: string;
  version: string;
  coreMinVersion: string;
  permissions: string[];
  menu: { title: string; routeKey: string }[];
  runtimeBindings?: Array<"ai" | "r2">;
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
};

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
  const files = unzipSync(bytes);
  const manifestBytes = files["manifest.json"];
  const worker = files["worker.mjs"];
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
  if (
    !Object.keys(d1Migrations).length ||
    JSON.stringify(Object.keys(d1Migrations)) !==
      JSON.stringify(Object.keys(postgresMigrations))
  )
    throw new Error(translate("plugins.migrationPairs"));
  const rawBytes =
    manifestBytes.byteLength +
    worker.byteLength +
    Object.values(d1Migrations).join("").length +
    Object.values(postgresMigrations).join("").length;
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
  form.set("manifest", parts.manifestText);
  form.set(
    "worker",
    new File([parts.worker.buffer as ArrayBuffer], "worker.mjs", {
      type: "application/javascript",
    }),
  );
  form.set("d1Migrations", JSON.stringify(parts.d1Migrations));
  form.set("postgresMigrations", JSON.stringify(parts.postgresMigrations));
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
  const choose = async (file?: File) => {
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
      setParts(selectedParts);
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
      const requiresR2 = requiresR2Provisioning(packageParts.manifest);
      const temporaryR2Token = r2Token.trim();
      try {
        if (packageParts.rawBytes > 4 * 1024 * 1024)
          throw new Error(t("plugins.rawTooLarge"));
        if (packageParts.gzipBytes > 3 * 1024 * 1024)
          throw new Error(t("plugins.gzipTooLarge"));
        if (requiresR2 && temporaryR2Token.length < 40)
          throw new Error(t("plugins.r2TokenRequired"));
        const r2Reauth = requiresR2
          ? await recentReauthHeaders(t("plugins.r2ReauthPassword"))
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
            if (!requiresR2 || temporaryR2Token.length < 40)
              throw new Error(t("plugins.r2TokenRequired"));
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
            setR2Token("");
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
          canCreate || canUpdate ? (
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
          Boolean(runtimeCredential.data && !runtimeCredential.data.configured)
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
              render: (row) => <span className="font-medium">{row.name}</span>,
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
                          downloadPackage.isPending || archivePackage.isPending
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
            {requiresR2Provisioning(parts.manifest) && (
              <section className="space-y-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm">
                <h3 className="font-semibold text-slate-900">
                  {t("plugins.r2ProvisioningTitle")}
                </h3>
                <p className="text-slate-700">
                  {t("plugins.r2ProvisioningDescription")}
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-slate-700">
                  <li>{t("plugins.r2ProvisioningStepPermission")}</li>
                  <li>{t("plugins.r2ProvisioningStepPaste")}</li>
                  <li>{t("plugins.r2ProvisioningStepRevoke")}</li>
                </ol>
                {runtimeCredential.data?.accountId && (
                  <a
                    className="inline-flex items-center gap-1 font-medium text-indigo-700 underline"
                    href={cloudflareUserTokensUrl()}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("plugins.r2OpenTokens")}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                <div>
                  <Label htmlFor="plugin-r2-token">
                    {t("plugins.r2TokenLabel")}
                  </Label>
                  <Input
                    id="plugin-r2-token"
                    type="password"
                    autoComplete="off"
                    minLength={40}
                    maxLength={2048}
                    value={r2Token}
                    onChange={(event) => setR2Token(event.target.value)}
                    placeholder={t("plugins.r2TokenPlaceholder")}
                    required
                  />
                </div>
                <p className="text-xs text-slate-600">
                  {t("plugins.r2TokenPrivacy")}
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
                  (requiresR2Provisioning(parts.manifest) &&
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
