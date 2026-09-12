import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DownloadCloud, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
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
import { api, recentReauthHeaders } from "../../lib/api/core-client.js";

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
  updateAvailable: boolean;
  sourceMatches: boolean;
};

type MarketplaceSyncResult = {
  id: string;
  requiresTrust?: boolean;
  publisherId?: string;
  publisherName?: string;
  keyId?: string;
  publicKey?: string;
  fingerprint?: string;
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
  const [pendingTrust, setPendingTrust] = useState<Required<
    Pick<
      MarketplaceSyncResult,
      | "id"
      | "publisherId"
      | "publisherName"
      | "keyId"
      | "publicKey"
      | "fingerprint"
    >
  > | null>(null);
  const [fingerprintConfirmation, setFingerprintConfirmation] = useState("");
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
  const requestTrust = (result: MarketplaceSyncResult): boolean => {
    if (
      !result.requiresTrust ||
      !result.publisherId ||
      !result.publisherName ||
      !result.keyId ||
      !result.publicKey ||
      !result.fingerprint
    )
      return false;
    setPendingTrust({
      id: result.id,
      publisherId: result.publisherId,
      publisherName: result.publisherName,
      keyId: result.keyId,
      publicKey: result.publicKey,
      fingerprint: result.fingerprint,
    });
    setFingerprintConfirmation("");
    return true;
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
        const result = await api<MarketplaceSyncResult>(
          `/api/v1/plugin-marketplaces/${encodeURIComponent(created.id)}/sync`,
          { method: "POST" },
        );
        if (!requestTrust(result)) toast.success(t("plugins.marketplaceAdded"));
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
      api<MarketplaceSyncResult>(
        `/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}/sync`,
        {
          method: "POST",
        },
      ),
    onSuccess: (result) => {
      refresh();
      if (!requestTrust(result)) toast.success(t("plugins.marketplaceSynced"));
    },
    onError: (error: Error) => {
      refresh();
      toast.error(error.message);
    },
  });
  const trustSource = useMutation({
    mutationFn: async () => {
      if (!pendingTrust) throw new Error(t("plugins.marketplaceTrustInvalid"));
      const headers = await recentReauthHeaders(
        t("plugins.marketplaceTrustReauthPassword"),
      );
      await api(
        `/api/v1/plugin-marketplaces/${encodeURIComponent(pendingTrust.id)}/trust-key`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            publicKey: pendingTrust.publicKey,
            keyId: pendingTrust.keyId,
            publisherId: pendingTrust.publisherId,
            expectedFingerprint: fingerprintConfirmation.trim(),
          }),
        },
      );
      return pendingTrust.id;
    },
    onSuccess: async (marketplaceId) => {
      setPendingTrust(null);
      setFingerprintConfirmation("");
      try {
        await api(
          `/api/v1/plugin-marketplaces/${encodeURIComponent(marketplaceId)}/sync`,
          { method: "POST" },
        );
        toast.success(t("plugins.marketplaceTrusted"));
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
  const toggleSource = useMutation({
    mutationFn: (source: Marketplace) =>
      api(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !Boolean(source.enabled) }),
      }),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(error.message),
  });
  const removeSource = useMutation({
    mutationFn: (source: Marketplace) =>
      api(`/api/v1/plugin-marketplaces/${encodeURIComponent(source.id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
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
    release.installedVersion
      ? canUpdatePlugin && release.updateAvailable && release.sourceMatches
      : canCreatePlugin;

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
            onOpen={(release) =>
              canUseRelease(release) && download.mutate(release)
            }
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
              onOpen={(source) => canUpdateSource && syncSource.mutate(source)}
              columns={[
                {
                  key: "name",
                  label: t("common.name"),
                  size: 220,
                  minSize: 140,
                  maxSize: 420,
                  sortValue: (row) => row.name,
                  render: (row) => (
                    <span className="font-medium">
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
                    <code>
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
                        {Boolean(row.enabled)
                          ? t("common.deactivate")
                          : t("common.activate")}
                      </Button>
                    </>
                  )}
                  {canDeleteSource && (
                    <Button
                      variant="ghost"
                      className="px-2 text-red-600"
                      onClick={() =>
                        confirm(
                          t("plugins.removeMarketplaceConfirm", {
                            name: row.name,
                          }),
                        ) && removeSource.mutate(row)
                      }
                      aria-label={`${t("common.delete")} ${row.name}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
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
        open={Boolean(pendingTrust)}
        onOpenChange={(open) => {
          if (!open && !trustSource.isPending) {
            setPendingTrust(null);
            setFingerprintConfirmation("");
          }
        }}
        title={t("plugins.marketplaceTrustTitle")}
        description={t("plugins.marketplaceTrustDescription")}
      >
        {pendingTrust && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              trustSource.mutate();
            }}
          >
            <p className="text-sm text-slate-700">
              {pendingTrust.publisherName} ({pendingTrust.publisherId})
            </p>
            <div>
              <Label htmlFor="marketplace-fingerprint">
                {t("plugins.marketplaceFingerprint")}
              </Label>
              <code className="mt-1 block break-all rounded-lg bg-slate-100 p-3 text-xs">
                {pendingTrust.fingerprint}
              </code>
            </div>
            <div>
              <Label htmlFor="marketplace-fingerprint-confirmation">
                {t("plugins.marketplaceFingerprintConfirmation")}
              </Label>
              <Input
                id="marketplace-fingerprint-confirmation"
                value={fingerprintConfirmation}
                onChange={(event) =>
                  setFingerprintConfirmation(event.target.value)
                }
                autoComplete="off"
                required
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPendingTrust(null)}
                disabled={trustSource.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                busy={trustSource.isPending}
                disabled={
                  fingerprintConfirmation.trim() !== pendingTrust.fingerprint
                }
              >
                {t("plugins.marketplaceTrustConfirm")}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
