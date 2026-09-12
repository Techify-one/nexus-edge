import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  DownloadCloud,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
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
  Skeleton,
} from "../../components/ui/index.js";
import { useI18n } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";
import { api } from "../../lib/api/core-client.js";

type Marketplace = {
  id: string;
  name: string;
  owner: string;
  repository: string;
  enabled: boolean | number;
  isDefault: boolean | number;
  trustState: string;
  keyFingerprint: string | null;
  lastSyncedAt: string | number | null;
  lastErrorCode: string | null;
};

type CatalogRelease = {
  id: string;
  marketplaceId: string;
  marketplaceName: string;
  pluginId: string;
  publisherId: string;
  publisherName: string;
  version: string;
  description: string;
  compatible: boolean | number;
  compatibilityReason: string | null;
  packageBytes: number | null;
  installedVersion: string | null;
  installedStatus: string | null;
  updateAvailable: boolean;
  sourceMatches: boolean;
};

export function MarketplacePanels({
  onSelectPackage,
  view,
}: {
  onSelectPackage: (file: File, releaseId: string) => Promise<void>;
  view: "catalog" | "marketplaces";
}) {
  const { t, formatDateTime } = useI18n();
  const queryClient = useQueryClient();
  const canReadSources = can("core.marketplace.read");
  const canCreateSource = can("core.marketplace.create");
  const canUpdateSource = can("core.marketplace.update");
  const canDeleteSource = can("core.marketplace.delete");
  const canCreatePlugin = can("core.plugin.create");
  const canUpdatePlugin = can("core.plugin.update");
  const [sourceModal, setSourceModal] = useState(false);
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [selectedRelease, setSelectedRelease] = useState<CatalogRelease | null>(
    null,
  );
  const [selectedSource, setSelectedSource] = useState<Marketplace | null>(
    null,
  );
  const [editedSourceName, setEditedSourceName] = useState("");
  const defaultSyncAttempted = useRef(false);
  const sources = useQuery({
    queryKey: ["plugin-marketplaces"],
    queryFn: () => api<{ items: Marketplace[] }>("/api/v1/plugin-marketplaces"),
    enabled: canReadSources,
  });
  const catalog = useQuery({
    queryKey: ["plugin-catalog"],
    queryFn: () => api<{ items: CatalogRelease[] }>("/api/v1/plugin-catalog"),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["plugin-marketplaces"] });
    void queryClient.invalidateQueries({ queryKey: ["plugin-catalog"] });
  };
  const createSource = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/v1/plugin-marketplaces", {
        method: "POST",
        body: JSON.stringify({ name, repository }),
      }),
    onSuccess: async (created) => {
      setSourceModal(false);
      setName("");
      setRepository("");
      try {
        await api(
          `/api/v1/plugin-marketplaces/${encodeURIComponent(created.id)}/sync`,
          { method: "POST" },
        );
        toast.success(t("plugins.marketplaceAdded"));
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("plugins.marketplaceDownloadFailed"),
        );
      } finally {
        refresh();
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const syncSource = useMutation({
    mutationFn: (source: Marketplace) =>
      api(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}/sync`, {
        method: "POST",
      }),
    onSuccess: () => {
      refresh();
      toast.success(t("plugins.marketplaceSynced"));
    },
    onError: (error: Error) => {
      refresh();
      toast.error(error.message);
    },
  });
  const updateSource = useMutation({
    mutationFn: (source: Marketplace) =>
      api(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name: editedSourceName.trim() }),
      }),
    onSuccess: () => {
      setSelectedSource(null);
      refresh();
      toast.success(t("plugins.marketplaceUpdated"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const toggleSource = useMutation({
    mutationFn: (source: Marketplace) =>
      api(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !Boolean(source.enabled) }),
      }),
    onSuccess: (_result, source) => {
      setSelectedSource((current) =>
        current?.id === source.id
          ? { ...current, enabled: !Boolean(source.enabled) }
          : current,
      );
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const removeSource = useMutation({
    mutationFn: (source: Marketplace) =>
      api(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setSelectedSource(null);
      refresh();
      toast.success(t("plugins.marketplaceRemoved"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const download = useMutation({
    mutationFn: async (release: CatalogRelease) => {
      const response = await fetch(
        `/api/v1/plugin-catalog/${encodeURIComponent(release.id)}/package`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(
          body?.error?.message || t("plugins.marketplaceDownloadFailed"),
        );
      }
      const blob = await response.blob();
      const releaseId = response.headers.get("X-Plugin-Release-Id");
      if (!releaseId) throw new Error(t("plugins.marketplaceDownloadFailed"));
      await onSelectPackage(
        new File([blob], `${release.pluginId}.plugin.zip`, {
          type: "application/zip",
        }),
        releaseId,
      );
      setSelectedRelease(null);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  useEffect(() => {
    if (
      defaultSyncAttempted.current ||
      !canUpdateSource ||
      syncSource.isPending
    )
      return;
    const pendingDefault = (sources.data?.items ?? []).find(
      (source) =>
        Boolean(source.isDefault) &&
        Boolean(source.enabled) &&
        source.trustState === "pending" &&
        !source.lastSyncedAt,
    );
    if (!pendingDefault) return;
    defaultSyncAttempted.current = true;
    syncSource.mutate(pendingDefault);
  }, [canUpdateSource, sources.data?.items, syncSource]);
  const catalogRows = useMemo(() => {
    const search = catalogSearch.trim().toLocaleLowerCase();
    return (catalog.data?.items ?? []).filter((release) =>
      `${release.pluginId} ${release.description} ${release.publisherName} ${release.marketplaceName}`
        .toLocaleLowerCase()
        .includes(search),
    );
  }, [catalog.data, catalogSearch]);
  const canUseRelease = (release: CatalogRelease): boolean =>
    release.installedStatus === "disabled"
      ? false
      : release.installedVersion
        ? canUpdatePlugin && release.updateAvailable && release.sourceMatches
        : canCreatePlugin;
  const copy = (value: string) =>
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.success(t("plugins.copied")))
      .catch(() => toast.error(t("plugins.copyFailed")));

  return (
    <div>
      <section
        aria-labelledby="plugin-catalog-heading"
        className="space-y-4"
        hidden={view !== "catalog"}
      >
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <h2 id="plugin-catalog-heading" className="text-lg font-semibold">
              {t("plugins.explore")}
            </h2>
            <p className="text-sm text-slate-500">
              {t("plugins.exploreDescription")}
            </p>
          </div>
          <div className="relative w-full sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={catalogSearch}
              onChange={(event) => setCatalogSearch(event.target.value)}
              className="pl-9"
              placeholder={t("plugins.searchMarketplace")}
              aria-label={t("plugins.searchMarketplace")}
            />
          </div>
        </div>
        {catalog.isPending ? (
          <Skeleton className="h-44" />
        ) : catalogRows.length ? (
          <ConfigurableDataTable
            tableId="core.plugin-catalog"
            rows={catalogRows}
            onOpen={setSelectedRelease}
            columns={[
              {
                key: "name",
                label: t("common.name"),
                size: 240,
                minSize: 140,
                maxSize: 500,
                sortValue: (row) => row.pluginId,
                render: (row) => (
                  <div>
                    <p className="font-medium">{row.pluginId}</p>
                    <p className="truncate text-xs text-slate-500">
                      {row.description}
                    </p>
                  </div>
                ),
              },
              {
                key: "publisher",
                label: t("plugins.publisher"),
                size: 180,
                minSize: 120,
                maxSize: 320,
                sortValue: (row) => row.publisherName,
                render: (row) => row.publisherName,
              },
              {
                key: "marketplace",
                label: t("plugins.marketplace"),
                size: 180,
                minSize: 120,
                maxSize: 320,
                sortValue: (row) => row.marketplaceName,
                render: (row) => row.marketplaceName,
              },
              {
                key: "version",
                label: t("common.version"),
                size: 120,
                minSize: 90,
                maxSize: 200,
                sortValue: (row) => row.version,
                render: (row) => row.version,
              },
              {
                key: "installation",
                label: t("plugins.installationStatus"),
                size: 160,
                minSize: 120,
                maxSize: 260,
                sortValue: (row) => row.installedStatus ?? "available",
                render: (row) => (
                  <Badge
                    tone={
                      row.installedStatus === "installed"
                        ? row.updateAvailable
                          ? "warning"
                          : "success"
                        : row.installedStatus === "disabled"
                          ? "warning"
                          : "neutral"
                    }
                  >
                    {row.installedStatus === "disabled"
                      ? t("plugins.state.disabled")
                      : row.installedVersion
                        ? row.updateAvailable
                          ? t("plugins.updateAvailable")
                          : t("plugins.alreadyInstalled")
                        : t("plugins.available")}
                  </Badge>
                ),
              },
              {
                key: "compatibility",
                label: t("plugins.compatibility"),
                size: 150,
                minSize: 110,
                maxSize: 240,
                sortValue: (row) => (Boolean(row.compatible) ? 1 : 0),
                render: (row) => (
                  <Badge tone={Boolean(row.compatible) ? "success" : "warning"}>
                    {Boolean(row.compatible)
                      ? t("plugins.compatible")
                      : t("plugins.incompatible")}
                  </Badge>
                ),
              },
            ]}
            actions={(row) =>
              canUseRelease(row) ? (
                <Button
                  variant="ghost"
                  className="px-2"
                  disabled={download.isPending || !Boolean(row.compatible)}
                  onClick={() => download.mutate(row)}
                  aria-label={`${row.installedVersion ? t("plugins.update") : t("plugins.install")} ${row.pluginId}`}
                >
                  <DownloadCloud className="h-4 w-4" />
                </Button>
              ) : row.installedVersion ? (
                <Badge tone="neutral">{t("plugins.alreadyInstalled")}</Badge>
              ) : null
            }
          />
        ) : (
          <div className="rounded-xl border border-dashed p-6 text-sm text-slate-500">
            {t("plugins.catalogEmpty")}
          </div>
        )}
      </section>

      {canReadSources && (
        <section
          aria-labelledby="plugin-marketplaces-heading"
          className="space-y-4"
          hidden={view !== "marketplaces"}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2
                id="plugin-marketplaces-heading"
                className="text-lg font-semibold"
              >
                {t("plugins.marketplaces")}
              </h2>
              <p className="text-sm text-slate-500">
                {t("plugins.marketplacesDescription")}
              </p>
            </div>
            {canCreateSource && (
              <Button variant="secondary" onClick={() => setSourceModal(true)}>
                <Plus className="h-4 w-4" />
                {t("plugins.addMarketplace")}
              </Button>
            )}
          </div>
          {sources.isPending ? (
            <Skeleton className="h-44" />
          ) : (
            <ConfigurableDataTable
              tableId="core.plugin-marketplaces"
              rows={sources.data?.items ?? []}
              onOpen={(source) => {
                setSelectedSource(source);
                setEditedSourceName(source.name);
              }}
              columns={[
                {
                  key: "name",
                  label: t("common.name"),
                  size: 220,
                  minSize: 140,
                  maxSize: 420,
                  sortValue: (row) => row.name,
                  render: (row) => (
                    <span className="select-text font-medium">
                      {row.name}
                      {Boolean(row.isDefault)
                        ? ` · ${t("plugins.defaultMarketplace")}`
                        : ""}
                    </span>
                  ),
                },
                {
                  key: "repository",
                  label: t("plugins.repository"),
                  size: 260,
                  minSize: 160,
                  maxSize: 500,
                  sortValue: (row) => `${row.owner}/${row.repository}`,
                  render: (row) => (
                    <code className="select-text">
                      {row.owner}/{row.repository}
                    </code>
                  ),
                },
                {
                  key: "trust",
                  label: t("plugins.trust"),
                  size: 140,
                  minSize: 100,
                  maxSize: 220,
                  sortValue: (row) => row.trustState,
                  render: (row) => (
                    <Badge
                      tone={
                        row.trustState === "trusted" ? "success" : "warning"
                      }
                    >
                      {row.trustState}
                    </Badge>
                  ),
                },
                {
                  key: "synced",
                  label: t("plugins.lastSync"),
                  size: 180,
                  minSize: 130,
                  maxSize: 300,
                  sortValue: (row) => String(row.lastSyncedAt ?? ""),
                  render: (row) =>
                    row.lastSyncedAt ? formatDateTime(row.lastSyncedAt) : "—",
                },
                {
                  key: "status",
                  label: t("common.status"),
                  size: 130,
                  minSize: 100,
                  maxSize: 220,
                  sortValue: (row) => (Boolean(row.enabled) ? 1 : 0),
                  render: (row) => (
                    <Badge tone={Boolean(row.enabled) ? "success" : "warning"}>
                      {Boolean(row.enabled)
                        ? t("common.active")
                        : t("common.inactive")}
                    </Badge>
                  ),
                },
              ]}
              actions={(row) => (
                <div className="flex justify-end gap-1">
                  {canUpdateSource && (
                    <>
                      <Button
                        variant="ghost"
                        className="px-2"
                        disabled={syncSource.isPending || !Boolean(row.enabled)}
                        onClick={() => syncSource.mutate(row)}
                        aria-label={`${t("plugins.syncMarketplace")} ${row.name}`}
                      >
                        <RefreshCw className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2"
                        onClick={() => toggleSource.mutate(row)}
                        aria-label={`${Boolean(row.enabled) ? t("common.deactivate") : t("common.activate")} ${row.name}`}
                      >
                        {Boolean(row.enabled) ? (
                          <PowerOff className="h-4 w-4" />
                        ) : (
                          <Power className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-2"
                        onClick={() => {
                          setSelectedSource(row);
                          setEditedSourceName(row.name);
                        }}
                        aria-label={`${t("common.edit")} ${row.name}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              )}
            />
          )}
        </section>
      )}

      <Modal
        open={sourceModal}
        onOpenChange={(open) => !createSource.isPending && setSourceModal(open)}
        title={t("plugins.addMarketplace")}
        description={t("plugins.marketplaceTrustNotice")}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            createSource.mutate();
          }}
        >
          <div>
            <Label htmlFor="marketplace-name">{t("common.name")}</Label>
            <Input
              id="marketplace-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </div>
          <div>
            <Label htmlFor="marketplace-repository">
              {t("plugins.repository")}
            </Label>
            <Input
              id="marketplace-repository"
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              placeholder="owner/repository"
              required
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSourceModal(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button busy={createSource.isPending}>{t("common.add")}</Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={Boolean(selectedRelease)}
        onOpenChange={(open) => {
          if (!open && !download.isPending) setSelectedRelease(null);
        }}
        title={selectedRelease?.pluginId ?? t("plugins.pluginDetails")}
        description={
          selectedRelease
            ? `${selectedRelease.publisherName} · ${selectedRelease.marketplaceName}`
            : undefined
        }
      >
        {selectedRelease && (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-xl border bg-slate-50 p-4 text-sm sm:grid-cols-2">
              <div>
                <span className="text-slate-500">ID</span>
                <p className="font-medium">{selectedRelease.pluginId}</p>
              </div>
              <div>
                <span className="text-slate-500">{t("common.version")}</span>
                <p>{selectedRelease.version}</p>
              </div>
              <div>
                <span className="text-slate-500">{t("plugins.publisher")}</span>
                <p>{selectedRelease.publisherName}</p>
              </div>
              <div>
                <span className="text-slate-500">
                  {t("plugins.marketplace")}
                </span>
                <p>{selectedRelease.marketplaceName}</p>
              </div>
              <div>
                <span className="text-slate-500">
                  {t("plugins.installationStatus")}
                </span>
                <p>
                  {selectedRelease.installedStatus === "disabled"
                    ? t("plugins.state.disabled")
                    : selectedRelease.installedVersion
                      ? selectedRelease.updateAvailable
                        ? t("plugins.updateAvailable")
                        : t("plugins.alreadyInstalled")
                      : t("plugins.available")}
                </p>
              </div>
              <div>
                <span className="text-slate-500">
                  {t("plugins.packageSize")}
                </span>
                <p>
                  {selectedRelease.packageBytes === null
                    ? "—"
                    : `${(selectedRelease.packageBytes / 1024).toFixed(1)} KiB`}
                </p>
              </div>
            </div>
            <section>
              <h3 className="text-sm font-semibold">
                {t("common.description")}
              </h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">
                {selectedRelease.description || "—"}
              </p>
            </section>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setSelectedRelease(null)}
                disabled={download.isPending}
              >
                {t("common.close")}
              </Button>
              {canUseRelease(selectedRelease) && (
                <Button
                  busy={download.isPending}
                  disabled={!Boolean(selectedRelease.compatible)}
                  onClick={() => download.mutate(selectedRelease)}
                >
                  <DownloadCloud className="h-4 w-4" />
                  {selectedRelease.installedVersion
                    ? t("plugins.update")
                    : t("plugins.install")}
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(selectedSource)}
        onOpenChange={(open) => {
          if (!open && !updateSource.isPending) setSelectedSource(null);
        }}
        title={selectedSource?.name ?? t("plugins.marketplace")}
        description={t("plugins.marketplaceDetails")}
      >
        {selectedSource && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              updateSource.mutate(selectedSource);
            }}
          >
            <div>
              <Label htmlFor="marketplace-edit-name">{t("common.name")}</Label>
              <div className="flex gap-2">
                <Input
                  id="marketplace-edit-name"
                  className="select-text"
                  value={editedSourceName}
                  onChange={(event) => setEditedSourceName(event.target.value)}
                  readOnly={!canUpdateSource}
                  required
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="px-3"
                  onClick={() => copy(editedSourceName)}
                  aria-label={t("plugins.copyMarketplaceName")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div>
              <Label>{t("plugins.repository")}</Label>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 select-text break-all rounded-xl border bg-slate-50 px-3 py-3 text-sm">
                  {selectedSource.owner}/{selectedSource.repository}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  className="px-3"
                  onClick={() =>
                    copy(`${selectedSource.owner}/${selectedSource.repository}`)
                  }
                  aria-label={t("plugins.copyMarketplaceRepository")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <div className="flex flex-wrap gap-2">
                {canUpdateSource && (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => toggleSource.mutate(selectedSource)}
                    busy={toggleSource.isPending}
                  >
                    {Boolean(selectedSource.enabled) ? (
                      <PowerOff className="h-4 w-4" />
                    ) : (
                      <Power className="h-4 w-4" />
                    )}
                    {Boolean(selectedSource.enabled)
                      ? t("common.deactivate")
                      : t("common.activate")}
                  </Button>
                )}
                {canDeleteSource && (
                  <Button
                    type="button"
                    variant="danger"
                    busy={removeSource.isPending}
                    onClick={() =>
                      confirm(
                        t("plugins.removeMarketplaceConfirm", {
                          name: selectedSource.name,
                        }),
                      ) && removeSource.mutate(selectedSource)
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("common.delete")}
                  </Button>
                )}
              </div>
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setSelectedSource(null)}
                >
                  {t("common.cancel")}
                </Button>
                {canUpdateSource && (
                  <Button
                    busy={updateSource.isPending}
                    disabled={editedSourceName.trim().length < 2}
                  >
                    {t("common.save")}
                  </Button>
                )}
              </div>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
