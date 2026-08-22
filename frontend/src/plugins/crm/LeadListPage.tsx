import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DataTable } from "../../components/ui/data-table.js";
import { Modal } from "../../components/ui/modal.js";
import {
  Badge,
  Button,
  Input,
  Label,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
} from "../../components/ui/index.js";
import { can } from "../../lib/ability.js";
import {
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";

type Lead = {
  id: string;
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  company?: string | undefined;
  status: "new" | "qualified" | "won" | "lost";
  notes?: string | undefined;
  version: number;
  ownerUserId: string;
};
const tone = (
  status: Lead["status"],
): "neutral" | "warning" | "success" | "danger" =>
  status === "won"
    ? "success"
    : status === "lost"
      ? "danger"
      : status === "qualified"
        ? "warning"
        : "neutral";
export default function LeadListPage() {
  const { t } = useI18n();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Lead | "new" | null>(null);
  const leads = useQuery({
    queryKey: ["crm", "leads", search],
    queryFn: () =>
      api<{ items: Lead[] }>(
        `/api/v1/p/crm/leads?limit=100&search=${encodeURIComponent(search)}`,
      ),
  });
  const current = selected === "new" ? null : selected;
  const save = useMutation({
    mutationFn: (
      input: Partial<Lead> & { name: string; status: Lead["status"] },
    ) =>
      api(
        current ? `/api/v1/p/crm/leads/${current.id}` : "/api/v1/p/crm/leads",
        {
          method: current ? "PATCH" : "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify(
            current ? { ...input, version: current.version } : input,
          ),
        },
      ),
    onSuccess: () => {
      toast.success(t("leads.saved"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["crm", "leads"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api(`/api/v1/p/crm/leads/${id}`, {
        method: "DELETE",
        headers: await recentReauthHeaders(t("leads.deletePassword")),
      }),
    onSuccess: () => {
      toast.success(t("leads.deleted"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["crm", "leads"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <>
      <PageHeader
        title={t("nav.leads")}
        description={t("leads.description")}
        action={
          can("crm.lead.create") ? (
            <Button onClick={() => setSelected("new")}>
              <Plus className="h-4 w-4" />
              {t("common.add")}
            </Button>
          ) : undefined
        }
      />
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-10"
          placeholder={t("leads.search")}
          aria-label={t("leads.search")}
        />
      </div>
      {leads.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          rows={leads.data?.items ?? []}
          onOpen={setSelected}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              className: "w-1/4",
              render: (row) => <span className="font-medium">{row.name}</span>,
            },
            {
              key: "company",
              label: t("leads.company"),
              className: "w-1/4",
              render: (row) => row.company || "—",
            },
            {
              key: "email",
              label: t("common.email"),
              render: (row) => row.email || "—",
            },
            {
              key: "phone",
              label: t("leads.phone"),
              className: "w-36",
              render: (row) => row.phone || "—",
            },
            {
              key: "status",
              label: t("common.status"),
              className: "w-32",
              render: (row) => (
                <Badge tone={tone(row.status)}>
                  {t(`leads.status.${row.status}`)}
                </Badge>
              ),
            },
          ]}
          actions={(row) => (
            <div className="flex justify-end gap-1">
              {can("crm.lead.update") && (
                <Button
                  variant="ghost"
                  className="px-2"
                  onClick={() => setSelected(row)}
                  aria-label={`${t("common.edit")} ${row.name}`}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {can("crm.lead.delete") && (
                <Button
                  variant="ghost"
                  className="px-2 text-red-600"
                  onClick={() =>
                    confirm(t("leads.deleteConfirm", { name: row.name })) &&
                    remove.mutate(row.id)
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
      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={
          selected === "new" ? t("leads.addTitle") : (current?.name ?? "Lead")
        }
        description={
          current
            ? t("leads.record", { id: current.id })
            : t("leads.formDescription")
        }
      >
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            save.mutate({
              name: String(form.get("name")),
              email: String(form.get("email")) || undefined,
              phone: String(form.get("phone")) || undefined,
              company: String(form.get("company")) || undefined,
              status: String(form.get("status")) as Lead["status"],
              notes: String(form.get("notes")) || undefined,
            });
          }}
        >
          <div className="sm:col-span-2">
            <Label htmlFor="lead-name">{t("common.name")}</Label>
            <Input
              id="lead-name"
              name="name"
              defaultValue={current?.name}
              required
              disabled={Boolean(current && !can("crm.lead.update"))}
            />
          </div>
          <div>
            <Label htmlFor="lead-email">{t("common.email")}</Label>
            <Input
              id="lead-email"
              name="email"
              type="email"
              defaultValue={current?.email}
            />
          </div>
          <div>
            <Label htmlFor="lead-phone">{t("leads.phone")}</Label>
            <Input id="lead-phone" name="phone" defaultValue={current?.phone} />
          </div>
          <div>
            <Label htmlFor="lead-company">{t("leads.company")}</Label>
            <Input
              id="lead-company"
              name="company"
              defaultValue={current?.company}
            />
          </div>
          <div>
            <Label htmlFor="lead-status">{t("common.status")}</Label>
            <Select
              id="lead-status"
              name="status"
              defaultValue={current?.status ?? "new"}
            >
              <option value="new">{t("leads.status.new")}</option>
              <option value="qualified">{t("leads.status.qualified")}</option>
              <option value="won">{t("leads.status.won")}</option>
              <option value="lost">{t("leads.status.lost")}</option>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="lead-notes">{t("leads.notes")}</Label>
            <Textarea
              id="lead-notes"
              name="notes"
              defaultValue={current?.notes}
            />
          </div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSelected(null)}
            >
              {t("common.close")}
            </Button>
            {(selected === "new"
              ? can("crm.lead.create")
              : can("crm.lead.update")) && (
              <Button busy={save.isPending}>{t("common.save")}</Button>
            )}
          </div>
        </form>
      </Modal>
    </>
  );
}
