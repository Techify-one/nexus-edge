import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState } from "react";
import { ConfigurableDataTable } from "../../components/ui/configurable-data-table.js";
import { Modal } from "../../components/ui/modal.js";
import {
  Badge,
  Input,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.js";
import { api } from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";

type AuditEntry = {
  id: string;
  requestId: string;
  userId?: string;
  authMethod?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata: Record<string, unknown>;
  createdAt: string | number;
};

export default function AuditPage() {
  const { t, formatDateTime } = useI18n();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const entries = useQuery({
    queryKey: ["audit", search],
    queryFn: () =>
      api<{ items: AuditEntry[] }>(
        `/api/v1/audit?limit=100&search=${encodeURIComponent(search)}`,
      ),
  });
  return (
    <>
      <PageHeader title={t("nav.audit")} description={t("audit.description")} />
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-10"
          placeholder={t("audit.search")}
          aria-label={t("audit.search")}
        />
      </div>
      {entries.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <ConfigurableDataTable
          tableId="core.audit"
          rows={entries.data?.items ?? []}
          onOpen={setSelected}
          emptyTitle={t("audit.noEvents")}
          emptyDescription={t("audit.noEventsDescription")}
          columns={[
            {
              key: "createdAt",
              label: t("common.date"),
              size: 200,
              minSize: 140,
              maxSize: 320,
              sortValue: (row) => new Date(row.createdAt).getTime(),
              render: (row) => formatDateTime(row.createdAt),
            },
            {
              key: "action",
              label: t("audit.action"),
              size: 220,
              minSize: 140,
              maxSize: 480,
              sortValue: (row) => row.action,
              render: (row) => (
                <span className="font-medium">{row.action}</span>
              ),
            },
            {
              key: "resource",
              label: t("audit.resource"),
              size: 300,
              minSize: 180,
              maxSize: 640,
              sortValue: (row) => `${row.resourceType} ${row.resourceId ?? ""}`,
              render: (row) =>
                `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ""}`,
            },
            {
              key: "auth",
              label: t("audit.authentication"),
              size: 160,
              minSize: 110,
              maxSize: 280,
              sortValue: (row) => row.authMethod ?? t("common.system"),
              render: (row) => (
                <Badge>{row.authMethod ?? t("common.system")}</Badge>
              ),
            },
            {
              key: "requestId",
              label: "Request ID",
              size: 240,
              minSize: 160,
              maxSize: 480,
              sortValue: (row) => row.requestId,
              render: (row) => <code>{row.requestId}</code>,
            },
          ]}
        />
      )}
      <Modal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={t("audit.record")}
        description={selected?.action}
      >
        {selected && (
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">{t("common.date")}</dt>
              <dd>{formatDateTime(selected.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-slate-500">{t("audit.authentication")}</dt>
              <dd>{selected.authMethod ?? t("common.system")}</dd>
            </div>
            <div>
              <dt className="text-slate-500">{t("audit.user")}</dt>
              <dd className="break-all">{selected.userId ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Request ID</dt>
              <dd className="break-all font-mono">{selected.requestId}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-slate-500">{t("audit.resource")}</dt>
              <dd>
                {selected.resourceType} · {selected.resourceId ?? "—"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="mb-1 text-slate-500">{t("audit.metadata")}</dt>
              <dd>
                <pre className="max-h-64 overflow-auto rounded-xl bg-slate-950 p-4 text-xs text-slate-100">
                  {JSON.stringify(selected.metadata, null, 2)}
                </pre>
              </dd>
            </div>
          </dl>
        )}
      </Modal>
    </>
  );
}
