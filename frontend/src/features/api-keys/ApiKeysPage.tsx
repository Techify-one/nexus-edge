import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../components/ui/configurable-data-table.js";
import { Modal } from "../../components/ui/modal.js";
import { PermissionChecklist } from "../../components/permissions/PermissionChecklist.js";
import {
  Badge,
  Button,
  Input,
  Label,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.js";
import { api } from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";

type ApiKey = {
  id: string;
  name?: string;
  start?: string;
  prefix?: string;
  enabled?: boolean;
  expiresAt?: string;
  createdAt: string;
  lastRequest?: string;
  permissions?: Record<string, string[]>;
};
type Permission = { id: string; key: string };

export default function ApiKeysPage() {
  const { t, formatDate, formatDateTime } = useI18n();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ApiKey | null>(null);
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const keys = useQuery({
    queryKey: ["api-keys"],
    queryFn: () => api<{ apiKeys: ApiKey[] }>("/api/v1/me/api-keys"),
  });
  const permissions = useQuery({
    queryKey: ["me", "permissions"],
    queryFn: () => api<{ items: Permission[] }>("/api/v1/me/permissions"),
  });
  const rows = useMemo(
    () =>
      (keys.data?.apiKeys ?? []).filter((key) =>
        (key.name ?? "").toLowerCase().includes(search.toLowerCase()),
      ),
    [keys.data, search],
  );
  const create = useMutation({
    mutationFn: async (form: FormData) => {
      return api<ApiKey & { key: string }>("/api/v1/me/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: form.get("name"),
          scopes: form.getAll("scopes"),
          expiresInDays: Number(form.get("days")),
        }),
      });
    },
    onSuccess: (data) => {
      setSecret(data.key);
      toast.success(t("apiKeys.createdSuccess"));
      void client.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/me/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("apiKeys.revokedSuccess"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["api-keys"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <>
      <PageHeader
        title={t("nav.apiKeys")}
        description={t("apiKeys.description")}
        action={
          <Button
            onClick={() => {
              setSecret("");
              setOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            {t("common.add")}
          </Button>
        }
      />
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-10"
          placeholder={t("apiKeys.search")}
          aria-label={t("apiKeys.search")}
        />
      </div>
      {keys.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <ConfigurableDataTable
          tableId="core.api-keys"
          rows={rows}
          onOpen={setSelected}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              size: 260,
              minSize: 140,
              maxSize: 600,
              sortValue: (row) => row.name || t("apiKeys.unnamed"),
              render: (row) => (
                <span className="font-medium">
                  {row.name || t("apiKeys.unnamed")}
                </span>
              ),
            },
            {
              key: "prefix",
              label: t("apiKeys.identifier"),
              size: 200,
              minSize: 140,
              maxSize: 360,
              sortValue: (row) => row.start || row.prefix || "app_…",
              render: (row) => (
                <code>{row.start || row.prefix || "app_…"}</code>
              ),
            },
            {
              key: "expires",
              label: t("common.expires"),
              size: 180,
              minSize: 120,
              maxSize: 320,
              sortValue: (row) => row.expiresAt ?? "",
              render: (row) =>
                row.expiresAt ? formatDate(row.expiresAt) : t("common.never"),
            },
            {
              key: "status",
              label: t("common.status"),
              size: 140,
              minSize: 100,
              maxSize: 240,
              sortValue: (row) => (row.enabled === false ? 1 : 0),
              render: (row) => (
                <Badge tone={row.enabled === false ? "danger" : "success"}>
                  {t(
                    row.enabled === false
                      ? "apiKeys.revoked"
                      : "apiKeys.active",
                  )}
                </Badge>
              ),
            },
          ]}
          actions={(row) => (
            <Button
              variant="ghost"
              className="px-2 text-red-600"
              onClick={() =>
                confirm(t("apiKeys.revokeConfirm")) && remove.mutate(row.id)
              }
              aria-label={t("apiKeys.deleteLabel")}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        />
      )}
      <Modal
        open={Boolean(selected)}
        onOpenChange={(value) => !value && setSelected(null)}
        title={selected?.name || t("apiKeys.titleSingle")}
      >
        <div className="space-y-3 text-sm">
          <p>
            <strong>{t("apiKeys.identifier")}:</strong>{" "}
            {selected?.start || selected?.prefix}
          </p>
          <p>
            <strong>{t("common.created")}:</strong>{" "}
            {selected && formatDateTime(selected.createdAt)}
          </p>
          <p>
            <strong>{t("apiKeys.lastUsed")}:</strong>{" "}
            {selected?.lastRequest
              ? formatDateTime(selected.lastRequest)
              : t("common.never")}
          </p>
          <Button variant="secondary" onClick={() => setSelected(null)}>
            {t("common.close")}
          </Button>
        </div>
      </Modal>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t("apiKeys.addTitle")}
        description={t("apiKeys.addDescription")}
      >
        {secret ? (
          <div className="space-y-4">
            <div className="rounded-xl border bg-slate-950 p-4 font-mono text-xs text-emerald-300 break-all">
              {secret}
            </div>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(secret);
                toast.success(t("apiKeys.copied"));
              }}
            >
              <KeyRound className="h-4 w-4" />
              {t("apiKeys.copySecret")}
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate(new FormData(event.currentTarget));
            }}
          >
            <div>
              <Label htmlFor="key-name">{t("common.name")}</Label>
              <Input id="key-name" name="name" required />
            </div>
            <div>
              <Label htmlFor="key-days">{t("apiKeys.validityDays")}</Label>
              <Input
                id="key-days"
                name="days"
                type="number"
                min="1"
                max="365"
                defaultValue="90"
                required
              />
            </div>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">
                {t("apiKeys.scopes")}
              </legend>
              <PermissionChecklist
                permissions={permissions.data?.items ?? []}
                name="scopes"
              />
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setOpen(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button busy={create.isPending}>{t("apiKeys.create")}</Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
