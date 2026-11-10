import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Button,
  Card,
  Input,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.js";
import { ConfigurableDataTable } from "../../components/ui/configurable-data-table.js";
import { Modal } from "../../components/ui/modal.js";
import { useI18n } from "../../i18n/index.js";
import { api } from "../../lib/api/core-client.js";

type Connection = { id: string; name: string; createdAt: number | string };
export default function McpPage() {
  const { t, formatDateTime } = useI18n();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Connection | null>(null);
  const client = useQueryClient();
  const connections = useQuery({
    queryKey: ["mcp-connections"],
    queryFn: () => api<{ items: Connection[] }>("/api/v1/me/mcp-connections"),
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/me/mcp-connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["mcp-connections"] });
      toast.success(t("mcp.revoked"));
    },
    onError: (error) => toast.error(error.message),
  });
  const endpoint = `${window.location.origin}/mcp`;
  return (
    <div className="space-y-3">
      <PageHeader
        title={t("mcp.connections")}
        description={t("mcp.description")}
      />
      <Input
        aria-label={t("mcp.search")}
        placeholder={t("mcp.search")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {connections.isPending ? (
        <Skeleton className="h-40" />
      ) : connections.isError ? (
        <Card className="p-4">
          <p role="alert">{connections.error.message}</p>
          <Button
            variant="secondary"
            onClick={() => void connections.refetch()}
          >
            {t("common.retry")}
          </Button>
        </Card>
      ) : (
        <ConfigurableDataTable
          tableId="core.mcp-connections"
          onOpen={setSelected}
          rows={(connections.data?.items ?? []).filter((connection) =>
            connection.name
              .toLocaleLowerCase()
              .includes(search.toLocaleLowerCase()),
          )}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              size: 320,
              minSize: 150,
              maxSize: 600,
              sortValue: (row) => row.name,
              render: (row) => row.name,
            },
            {
              key: "createdAt",
              label: t("mcp.createdAt"),
              size: 240,
              minSize: 160,
              maxSize: 400,
              sortValue: (row) => Number(row.createdAt),
              render: (row) => formatDateTime(Number(row.createdAt)),
            },
          ]}
          actions={(row) => (
            <Button
              variant="danger"
              busy={revoke.isPending}
              onClick={() => {
                if (confirm(t("mcp.revokeConfirm"))) revoke.mutate(row.id);
              }}
            >
              {t("mcp.revoke")}
            </Button>
          )}
        />
      )}
      <Card className="space-y-4 p-5">
        <h2 className="font-semibold">{t("mcp.connectTitle")}</h2>
        <p className="text-sm text-slate-500">{t("mcp.connectDescription")}</p>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={t("mcp.endpoint")}
            readOnly
            value={endpoint}
            className="min-w-0 flex-1 font-mono"
          />
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard
                .writeText(endpoint)
                .then(() => toast.success(t("apiKeys.copied")))
                .catch(() => toast.error(t("errors.fallback")));
            }}
          >
            {t("common.copy")}
          </Button>
        </div>
        <p className="text-sm">{t("mcp.oauthHelp")}</p>
        <pre className="overflow-x-auto rounded-xl border p-3 text-xs">{`claude mcp add --transport http nexus ${endpoint}`}</pre>
        <p className="text-sm text-slate-500">{t("mcp.apiKeyHelp")}</p>
        <div className="flex flex-wrap gap-4 text-sm font-medium text-indigo-600 underline">
          <Link to="/app/plugins/installed">{t("mcp.configurePlugins")}</Link>
          <Link to="/app/settings/api-keys">{t("nav.apiKeys")}</Link>
        </div>
      </Card>
      <Modal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected?.name ?? t("mcp.connections")}
      >
        {selected && (
          <div className="space-y-4">
            <p>
              {t("mcp.createdAt")}: {formatDateTime(Number(selected.createdAt))}
            </p>
            <Button
              variant="danger"
              busy={revoke.isPending}
              onClick={() => {
                if (confirm(t("mcp.revokeConfirm"))) {
                  revoke.mutate(selected.id);
                  setSelected(null);
                }
              }}
            >
              {t("mcp.revoke")}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
