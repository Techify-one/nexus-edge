import { gzipSync, strFromU8, unzipSync } from "fflate";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackagePlus, Pencil, Search, Trash2, UploadCloud } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { api, idempotencyKey } from "../../lib/api/core-client.js";
import { translate, useI18n, type TranslationKey } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";

type Manifest = {
  id: string;
  name: string;
  version: string;
  coreMinVersion: string;
  permissions: string[];
  menu: { title: string; routeKey: string }[];
};
type Plugin = {
  id: string;
  name: string;
  installedVersion: string;
  apiVersion: number;
  databaseProvider: string;
  workerName: string;
  status: string;
  installedAt: string | number;
};
type Operation = {
  operationId: string;
  pluginId: string;
  type: "install" | "update";
  targetVersion: string;
  state: string;
  lastError?: string;
  hasError?: boolean | number;
  createdAt?: string | number;
};
type OperationRow = Operation & { id: string };
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

const states = [
  "validating",
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
  const { t, formatDateTime } = useI18n();
  const canCreate = can("core.plugin.create");
  const canUpdate = can("core.plugin.update");
  const canDelete = can("core.plugin.delete");
  const stateLabel = (state: string) =>
    stateKeys[state] ? t(stateKeys[state]) : state;
  const client = useQueryClient();
  const navigate = useNavigate();
  const { operationId } = useParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Plugin | null>(null);
  const [parts, setParts] = useState<PluginParts | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [resumeTarget, setResumeTarget] = useState<OperationRow | null>(null);
  const plugins = useQuery({
    queryKey: ["plugins"],
    queryFn: () => api<{ items: Plugin[] }>("/api/v1/plugins"),
  });
  const operations = useQuery({
    queryKey: ["plugin-operations"],
    queryFn: () => api<{ items: Operation[] }>("/api/v1/plugin-operations"),
  });
  const operationRows = useMemo<OperationRow[]>(
    () =>
      (operations.data?.items ?? []).map((item) => ({
        ...item,
        id: item.operationId,
      })),
    [operations.data],
  );
  useEffect(() => {
    if (!operationId || !operationRows.length) return;
    const target = operationRows.find(
      (item) => item.operationId === operationId,
    );
    if (target) setResumeTarget(target);
  }, [operationId, operationRows]);
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
      const operationType = resumeTarget?.type
        ? resumeTarget.type
        : (plugins.data?.items ?? []).some(
              (plugin) => plugin.id === selectedParts.manifest.id,
            )
          ? "update"
          : "install";
      if (
        (operationType === "update" && !canUpdate) ||
        (operationType === "install" && !canCreate)
      )
        throw new Error(t("plugins.permissionRequired"));
      setParts(selectedParts);
      setOperation(resumeTarget);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("plugins.invalidPackage"),
      );
    }
  };
  const install = useMutation({
    mutationFn: async ({
      packageParts,
      resume,
    }: {
      packageParts: PluginParts;
      resume?: OperationRow | undefined;
    }) => {
      if (packageParts.rawBytes > 4 * 1024 * 1024)
        throw new Error(t("plugins.rawTooLarge"));
      if (packageParts.gzipBytes > 3 * 1024 * 1024)
        throw new Error(t("plugins.gzipTooLarge"));
      let current = resume
        ? await api<Operation>(
            `/api/v1/plugin-operations/${resume.operationId}/resume`,
            { method: "POST" },
          )
        : await api<Operation>("/api/v1/plugin-operations", {
            method: "POST",
            headers: {
              "Idempotency-Key": idempotencyKey(),
            },
            body: bodyFor(packageParts),
          });
      setOperation(current);
      while (!terminal.has(current.state)) {
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
    },
    onSuccess: () => {
      toast.success(t("plugins.installed"));
      setParts(null);
      setResumeTarget(null);
      navigate("/app/plugins", { replace: true });
      void client.invalidateQueries({ queryKey: ["plugins"] });
      void client.invalidateQueries({ queryKey: ["plugin-operations"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
      void client.invalidateQueries({
        queryKey: ["me", "plugin-navigation"],
      });
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey: ["plugin-operations"] });
    },
  });
  const remove = useMutation({
    mutationFn: (plugin: Plugin) =>
      api(`/api/v1/plugins/${plugin.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("plugins.uninstalled"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["plugins"] });
      void client.invalidateQueries({ queryKey: ["plugin-operations"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
      void client.invalidateQueries({
        queryKey: ["me", "plugin-navigation"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <>
      <PageHeader
        title={t("nav.plugins")}
        description={t("plugins.description")}
        action={
          canCreate || canUpdate ? (
            <Button
              onClick={() => {
                setResumeTarget(null);
                setOperation(null);
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
            canUpdate || canDelete
              ? (row) => (
                  <div className="flex justify-end gap-1">
                    {canUpdate && (
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
                            t("plugins.uninstallConfirm", {
                              name: row.name,
                              version: row.installedVersion,
                            }),
                          ) && remove.mutate(row)
                        }
                        aria-label={`${t("common.delete")} ${row.name}`}
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
      <h2 className="mb-3 mt-8 text-lg font-bold">
        {t("plugins.recentOperations")}
      </h2>
      {operations.isPending ? (
        <Skeleton className="h-48" />
      ) : (
        <ConfigurableDataTable
          tableId="core.plugin-operations"
          rows={operationRows}
          onOpen={(row) => {
            setResumeTarget(row);
            navigate(
              `/app/plugins/${row.pluginId}/operations/${row.operationId}`,
            );
          }}
          emptyTitle={t("plugins.noOperations")}
          emptyDescription={t("plugins.noOperationsDescription")}
          columns={[
            {
              key: "plugin",
              label: "Plugin",
              size: 240,
              minSize: 140,
              maxSize: 520,
              sortValue: (row) => row.pluginId,
              render: (row) => (
                <span className="font-medium">{row.pluginId}</span>
              ),
            },
            {
              key: "version",
              label: t("common.version"),
              size: 140,
              minSize: 96,
              maxSize: 240,
              sortValue: (row) => row.targetVersion,
              render: (row) => row.targetVersion,
            },
            {
              key: "state",
              label: t("plugins.stage"),
              size: 180,
              minSize: 120,
              maxSize: 320,
              sortValue: (row) => row.state,
              render: (row) => (
                <Badge
                  tone={
                    row.state === "installed"
                      ? "success"
                      : row.state === "failed"
                        ? "danger"
                        : "warning"
                  }
                >
                  {stateLabel(row.state)}
                </Badge>
              ),
            },
            {
              key: "operation",
              label: t("plugins.operationId"),
              size: 320,
              minSize: 180,
              maxSize: 720,
              sortValue: (row) => row.operationId,
              render: (row) => <code>{row.operationId}</code>,
            },
          ]}
        />
      )}
      <Modal
        open={Boolean(resumeTarget && !parts)}
        onOpenChange={(open) => {
          if (!open) {
            setResumeTarget(null);
            navigate("/app/plugins", { replace: true });
          }
        }}
        title={t("plugins.installerOperation")}
        description={resumeTarget?.operationId}
      >
        {resumeTarget && (
          <div className="space-y-4 text-sm">
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-slate-500">Plugin</dt>
                <dd>{resumeTarget.pluginId}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("common.version")}</dt>
                <dd>{resumeTarget.targetVersion}</dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("plugins.state")}</dt>
                <dd>
                  <Badge
                    tone={
                      resumeTarget.state === "failed"
                        ? "danger"
                        : resumeTarget.state === "installed"
                          ? "success"
                          : "warning"
                    }
                  >
                    {stateLabel(resumeTarget.state)}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("common.created")}</dt>
                <dd>
                  {resumeTarget.createdAt
                    ? formatDateTime(resumeTarget.createdAt)
                    : "—"}
                </dd>
              </div>
            </dl>
            {resumeTarget.state === "failed" && (
              <p className="rounded-xl bg-amber-50 p-3 text-amber-800">
                {t("plugins.failedHelp")}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setResumeTarget(null);
                  navigate("/app/plugins", { replace: true });
                }}
              >
                {t("common.close")}
              </Button>
              {resumeTarget.state === "failed" &&
                (resumeTarget.type === "update" ? canUpdate : canCreate) && (
                  <Button onClick={() => inputRef.current?.click()}>
                    <UploadCloud className="h-4 w-4" />
                    {t("plugins.selectAndResume")}
                  </Button>
                )}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(parts)}
        onOpenChange={(open) => {
          if (!open && !install.isPending) setParts(null);
        }}
        title={
          resumeTarget ? t("plugins.resumeTitle") : t("plugins.installTitle")
        }
        description={
          parts ? `${parts.manifest.name} ${parts.manifest.version}` : undefined
        }
      >
        {parts && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              install.mutate({
                packageParts: parts,
                resume: resumeTarget ?? undefined,
              });
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
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={install.isPending}
                onClick={() => setParts(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button busy={install.isPending}>
                <UploadCloud className="h-4 w-4" />
                {resumeTarget
                  ? t("plugins.resume")
                  : rows.some((row) => row.id === parts.manifest.id)
                    ? t("plugins.update")
                    : t("plugins.install")}
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
              {canUpdate && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelected(null);
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
                      t("plugins.uninstallConfirm", {
                        name: selected.name,
                        version: selected.installedVersion,
                      }),
                    ) && remove.mutate(selected)
                  }
                >
                  <Trash2 className="h-4 w-4" />
                  {t("plugins.uninstall")}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
