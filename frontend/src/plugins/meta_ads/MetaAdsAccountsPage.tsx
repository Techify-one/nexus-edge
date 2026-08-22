import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheck,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../components/ui/configurable-data-table.js";
import { Modal } from "../../components/ui/modal.js";
import {
  Badge,
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  PasswordInput,
  Skeleton,
} from "../../components/ui/index.js";
import { useI18n } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";
import {
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../lib/api/core-client.js";
import type { AdAccount } from "./types.js";

type Selected = AdAccount | "new" | null;

export default function MetaAdsAccountsPage() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [selected, setSelected] = useState<Selected>(null);
  const [accessToken, setAccessToken] = useState("");
  const current = selected === "new" ? null : selected;
  const accounts = useQuery({
    queryKey: ["meta-ads", "accounts"],
    retry: false,
    staleTime: 300_000,
    queryFn: ({ signal }) =>
      api<{ items: AdAccount[] }>("/api/v1/p/meta_ads/accounts", { signal }),
  });
  const secretStatus = useQuery({
    queryKey: ["meta-ads", "access-token-status"],
    enabled: can("meta_ads.account.read"),
    retry: false,
    staleTime: 60_000,
    queryFn: () =>
      api<{ configured: boolean }>(
        "/api/v1/plugins/meta_ads/runtime-secrets/META_ACCESS_TOKEN",
      ),
  });
  const saveAccessToken = useMutation({
    mutationFn: async (value: string) => {
      const headers = await recentReauthHeaders(
        t("metaAds.accounts.tokenSavePassword"),
      );
      await api("/api/v1/plugins/meta_ads/runtime-secrets/META_ACCESS_TOKEN", {
        method: "PUT",
        headers,
        body: JSON.stringify({ value }),
      });
    },
    onSuccess: () => {
      setAccessToken("");
      toast.success(t("metaAds.accounts.tokenSaved"));
      void client.invalidateQueries({
        queryKey: ["meta-ads", "access-token-status"],
      });
      void client.invalidateQueries({ queryKey: ["meta-ads"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const deleteAccessToken = useMutation({
    mutationFn: async () =>
      api("/api/v1/plugins/meta_ads/runtime-secrets/META_ACCESS_TOKEN", {
        method: "DELETE",
        headers: await recentReauthHeaders(
          t("metaAds.accounts.tokenDeletePassword"),
        ),
      }),
    onSuccess: () => {
      toast.success(t("metaAds.accounts.tokenDeleted"));
      void client.invalidateQueries({
        queryKey: ["meta-ads", "access-token-status"],
      });
      void client.invalidateQueries({ queryKey: ["meta-ads"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: (input: {
      name: string;
      adAccountId: string;
      enabled: boolean;
    }) =>
      api<AdAccount>(
        current
          ? `/api/v1/p/meta_ads/accounts/${current.id}`
          : "/api/v1/p/meta_ads/accounts",
        {
          method: current ? "PATCH" : "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify(
            current ? { ...input, version: current.version } : input,
          ),
        },
      ),
    onSuccess: () => {
      toast.success(t("metaAds.accounts.saved"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["meta-ads", "accounts"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (account: AdAccount) =>
      api(`/api/v1/p/meta_ads/accounts/${account.id}`, {
        method: "DELETE",
        headers: await recentReauthHeaders(
          t("metaAds.accounts.deletePassword"),
        ),
      }),
    onSuccess: () => {
      toast.success(t("metaAds.accounts.deleted"));
      void client.invalidateQueries({ queryKey: ["meta-ads", "accounts"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const testConnection = useMutation({
    mutationFn: (account: AdAccount) =>
      api(`/api/v1/p/meta_ads/accounts/${account.id}/test`, {
        method: "POST",
      }),
    onSuccess: () => toast.success(t("metaAds.accounts.connectionOk")),
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <>
      <PageHeader
        title={t("metaAds.accounts.title")}
        description={t("metaAds.accounts.description")}
        action={
          can("meta_ads.account.create") ? (
            <Button onClick={() => setSelected("new")}>
              <Plus className="h-4 w-4" />
              {t("common.add")}
            </Button>
          ) : undefined
        }
      />
      <Card className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-indigo-50 text-indigo-700">
              <KeyRound className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-semibold">
                  {t("metaAds.accounts.tokenTitle")}
                </h2>
                <Badge
                  tone={secretStatus.data?.configured ? "success" : "neutral"}
                >
                  {secretStatus.data?.configured
                    ? t("metaAds.accounts.tokenConfigured")
                    : t("metaAds.accounts.tokenMissing")}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {t("metaAds.accounts.tokenDescription")}
              </p>
            </div>
          </div>
          {secretStatus.data?.configured && can("meta_ads.account.update") && (
            <Button
              type="button"
              variant="ghost"
              className="text-red-600"
              busy={deleteAccessToken.isPending}
              onClick={() => {
                if (confirm(t("metaAds.accounts.tokenDeleteConfirm")))
                  deleteAccessToken.mutate();
              }}
            >
              <Trash2 className="h-4 w-4" />
              {t("metaAds.accounts.tokenDelete")}
            </Button>
          )}
        </div>
        {can("meta_ads.account.update") && (
          <form
            className="mt-4 flex flex-col gap-2 sm:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (accessToken.trim().length >= 20)
                saveAccessToken.mutate(accessToken.trim());
            }}
          >
            <PasswordInput
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder={t("metaAds.accounts.tokenPlaceholder")}
              aria-label={t("metaAds.accounts.tokenTitle")}
              minLength={20}
              required
            />
            <Button
              className="shrink-0"
              busy={saveAccessToken.isPending}
              disabled={accessToken.trim().length < 20}
            >
              {secretStatus.data?.configured
                ? t("metaAds.accounts.tokenReplace")
                : t("metaAds.accounts.tokenAdd")}
            </Button>
          </form>
        )}
      </Card>
      {accounts.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <ConfigurableDataTable
          tableId="plugin.meta_ads.accounts"
          rows={accounts.data?.items ?? []}
          onOpen={setSelected}
          emptyTitle={t("metaAds.accounts.empty")}
          emptyDescription={t("metaAds.accounts.emptyDescription")}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              render: (row) => <span className="font-medium">{row.name}</span>,
              sortValue: (row) => row.name,
              size: 260,
              minSize: 140,
              maxSize: 600,
            },
            {
              key: "ad_account_id",
              label: t("metaAds.accounts.id"),
              render: (row) => (
                <span className="font-mono text-xs">{row.adAccountId}</span>
              ),
              sortValue: (row) => row.adAccountId,
              size: 220,
              minSize: 160,
              maxSize: 360,
            },
            {
              key: "currency",
              label: t("metaAds.accounts.currency"),
              render: (row) => row.currency || "—",
              sortValue: (row) => row.currency || "",
              size: 130,
              minSize: 100,
              maxSize: 200,
            },
            {
              key: "timezone",
              label: t("metaAds.accounts.timezone"),
              render: (row) => row.timezoneName || "—",
              sortValue: (row) => row.timezoneName || "",
              size: 220,
              minSize: 140,
              maxSize: 420,
            },
            {
              key: "status",
              label: t("common.status"),
              render: (row) => (
                <Badge tone={row.enabled ? "success" : "neutral"}>
                  {t(row.enabled ? "common.active" : "common.inactive")}
                </Badge>
              ),
              sortValue: (row) => (row.enabled ? 1 : 0),
              size: 140,
              minSize: 110,
              maxSize: 220,
            },
          ]}
          actions={(row) => (
            <div className="flex justify-end gap-1">
              {can("meta_ads.account.read") && (
                <Button
                  variant="ghost"
                  className="px-2"
                  onClick={() => testConnection.mutate(row)}
                  aria-label={`${t("metaAds.accounts.test")} ${row.name}`}
                  title={t("metaAds.accounts.test")}
                >
                  {testConnection.isPending ? (
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  ) : (
                    <CircleCheck className="h-4 w-4" />
                  )}
                </Button>
              )}
              {can("meta_ads.account.update") && (
                <Button
                  variant="ghost"
                  className="px-2"
                  onClick={() => setSelected(row)}
                  aria-label={`${t("common.edit")} ${row.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {can("meta_ads.account.delete") && (
                <Button
                  variant="ghost"
                  className="px-2 text-red-600"
                  onClick={() => {
                    if (
                      confirm(
                        t("metaAds.accounts.deleteConfirm", {
                          name: row.name,
                        }),
                      )
                    )
                      remove.mutate(row);
                  }}
                  aria-label={`${t("common.delete")} ${row.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        />
      )}
      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={
          selected === "new"
            ? t("metaAds.accounts.addTitle")
            : current?.name || t("metaAds.accounts.title")
        }
        description={t("metaAds.accounts.formDescription")}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            save.mutate({
              name: String(form.get("name")),
              adAccountId: String(form.get("adAccountId")),
              enabled: form.get("enabled") === "on",
            });
          }}
        >
          <div>
            <Label htmlFor="meta-account-name">{t("common.name")}</Label>
            <Input
              id="meta-account-name"
              name="name"
              defaultValue={current?.name}
              required
              maxLength={120}
            />
          </div>
          <div>
            <Label htmlFor="meta-account-id">{t("metaAds.accounts.id")}</Label>
            <Input
              id="meta-account-id"
              name="adAccountId"
              defaultValue={current?.adAccountId}
              placeholder="act_123456789"
              pattern="act_[0-9]{6,30}"
              required
            />
            <p className="mt-1 text-xs text-slate-500">
              {t("metaAds.accounts.idHelp")}
            </p>
          </div>
          <label className="flex items-center gap-3 rounded-xl border p-3 text-sm">
            <input
              name="enabled"
              type="checkbox"
              defaultChecked={current?.enabled ?? true}
              className="h-4 w-4"
            />
            {t("metaAds.accounts.enabled")}
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSelected(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button busy={save.isPending}>{t("common.save")}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
