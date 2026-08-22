import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Pencil,
  Plus,
  Redo2,
  RotateCw,
  Search,
  Send,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DataTable } from "../../components/ui/data-table.js";
import { Modal } from "../../components/ui/modal.js";
import {
  Badge,
  Button,
  Input,
  Label,
  PageHeader,
  PasswordInput,
  Skeleton,
} from "../../components/ui/index.js";
import { api, idempotencyKey } from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";

type Endpoint = {
  id: string;
  name: string;
  enabled: boolean | number;
  host: string;
  url: string;
  eventTypes: string[];
  keyId: string;
  createdAt: string;
};
type Delivery = {
  id: string;
  endpointId: string;
  eventId: string;
  status: string;
  attemptCount: number;
  lastStatusCode?: number;
  host: string;
};

export default function WebhooksPage() {
  const { t } = useI18n();
  const canCreate = can("core.webhook.create");
  const canUpdate = can("core.webhook.update");
  const canDelete = can("core.webhook.delete");
  const canTest = can("core.webhook.test");
  const canRedeliver = can("core.webhook.redeliver");
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Endpoint | "new" | null>(null);
  const [revealed, setRevealed] = useState("");
  const endpoints = useQuery({
    queryKey: ["webhooks", "endpoints"],
    queryFn: () => api<{ items: Endpoint[] }>("/api/v1/webhooks/endpoints"),
  });
  const events = useQuery({
    queryKey: ["webhooks", "event-types"],
    queryFn: () => api<{ items: string[] }>("/api/v1/webhooks/event-types"),
  });
  const deliveries = useQuery({
    queryKey: ["webhooks", "deliveries"],
    queryFn: () => api<{ items: Delivery[] }>("/api/v1/webhooks/deliveries"),
  });
  const rows = useMemo(
    () =>
      (endpoints.data?.items ?? []).filter((endpoint) =>
        `${endpoint.name} ${endpoint.host}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [endpoints.data, search],
  );
  const current = selected === "new" ? null : selected;
  const editable = selected === "new" ? canCreate : canUpdate;
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const payload = {
        name: form.get("name"),
        enabled: form.get("enabled") === "on",
        eventTypes: form.getAll("eventTypes"),
      };
      if (current)
        return api(`/api/v1/webhooks/endpoints/${current.id}`, {
          method: "PATCH",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify(payload),
        });
      const reauth = await api<{ token: string }>("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password: form.get("password") }),
      });
      return api<{ secret: string }>("/api/v1/webhooks/endpoints", {
        method: "POST",
        headers: {
          "X-Reauth-Token": reauth.token,
          "Idempotency-Key": idempotencyKey(),
        },
        body: JSON.stringify({ ...payload, url: form.get("url") }),
      });
    },
    onSuccess: (data) => {
      const secret = (data as { secret?: string }).secret;
      if (secret) setRevealed(secret);
      else setSelected(null);
      toast.success(t("webhooks.saved"));
      void client.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const password = prompt(t("webhooks.deletePassword"));
      if (!password) throw new Error(t("common.operationCancelled"));
      const reauth = await api<{ token: string }>("/api/v1/auth/reauth", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      return api(`/api/v1/webhooks/endpoints/${id}`, {
        method: "DELETE",
        headers: { "X-Reauth-Token": reauth.token },
      });
    },
    onSuccess: () => {
      toast.success(t("webhooks.deleted"));
      void client.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const action = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: string }) => {
      const headers: Record<string, string> = {
        "Idempotency-Key": idempotencyKey(),
      };
      if (action === "rotate-secret") {
        const password = prompt(t("webhooks.rotatePassword"));
        if (!password) throw new Error(t("common.operationCancelled"));
        const reauth = await api<{ token: string }>("/api/v1/auth/reauth", {
          method: "POST",
          body: JSON.stringify({ password }),
        });
        headers["X-Reauth-Token"] = reauth.token;
      }
      return api<{ secret?: string }>(
        `/api/v1/webhooks/endpoints/${id}/${action}`,
        { method: "POST", headers },
      );
    },
    onSuccess: (data) => {
      if (data.secret) setRevealed(data.secret);
      toast.success(
        t(data.secret ? "webhooks.secretRotated" : "webhooks.actionQueued"),
      );
      void client.invalidateQueries({ queryKey: ["webhooks"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const redeliver = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/webhooks/deliveries/${id}/redeliver`, { method: "POST" }),
    onSuccess: () => {
      toast.success(t("webhooks.redeliveryQueued"));
      void client.invalidateQueries({ queryKey: ["webhooks", "deliveries"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  return (
    <>
      <PageHeader
        title={t("nav.webhooks")}
        description={t("webhooks.description")}
        action={
          canCreate ? (
            <Button
              onClick={() => {
                setRevealed("");
                setSelected("new");
              }}
            >
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
          placeholder={t("webhooks.search")}
          aria-label={t("webhooks.search")}
        />
      </div>
      {endpoints.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          rows={rows}
          onOpen={setSelected}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              className: "w-1/4",
              render: (row) => <span className="font-medium">{row.name}</span>,
            },
            {
              key: "url",
              label: t("webhooks.destination"),
              render: (row) => row.url,
            },
            {
              key: "events",
              label: t("webhooks.events"),
              className: "w-32",
              render: (row) =>
                t("webhooks.eventTypes", { count: row.eventTypes.length }),
            },
            {
              key: "status",
              label: t("common.status"),
              className: "w-28",
              render: (row) => (
                <Badge tone={Boolean(row.enabled) ? "success" : "danger"}>
                  {t(
                    Boolean(row.enabled) ? "common.active" : "common.inactive",
                  )}
                </Badge>
              ),
            },
          ]}
          actions={
            canUpdate || canTest || canDelete
              ? (row) => (
                  <div className="flex justify-end gap-1">
                    {canUpdate && (
                      <Button
                        variant="ghost"
                        className="px-2"
                        onClick={() => setSelected(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canTest && (
                      <Button
                        variant="ghost"
                        className="px-2"
                        onClick={() =>
                          action.mutate({ id: row.id, action: "test" })
                        }
                        aria-label={t("webhooks.test")}
                      >
                        <Send className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        className="px-2 text-red-600"
                        onClick={() =>
                          confirm(
                            t("common.deleteConfirm", { name: row.name }),
                          ) && remove.mutate(row.id)
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
        {t("webhooks.recentDeliveries")}
      </h2>
      <DataTable
        rows={deliveries.data?.items ?? []}
        onOpen={() => undefined}
        emptyTitle={t("webhooks.noDeliveries")}
        emptyDescription={t("webhooks.noDeliveriesDescription")}
        columns={[
          {
            key: "event",
            label: t("webhooks.event"),
            render: (row) => <code>{row.eventId}</code>,
          },
          {
            key: "host",
            label: t("webhooks.destination"),
            render: (row) => row.host,
          },
          {
            key: "attempts",
            label: t("webhooks.attempts"),
            className: "w-28",
            render: (row) => row.attemptCount,
          },
          {
            key: "status",
            label: t("common.status"),
            className: "w-32",
            render: (row) => (
              <Badge
                tone={
                  row.status === "delivered"
                    ? "success"
                    : row.status === "failed"
                      ? "danger"
                      : "warning"
                }
              >
                {t(
                  row.status === "delivered"
                    ? "webhooks.deliveryStatus.delivered"
                    : row.status === "failed"
                      ? "webhooks.deliveryStatus.failed"
                      : "webhooks.deliveryStatus.pending",
                )}
              </Badge>
            ),
          },
        ]}
        actions={
          canRedeliver
            ? (row) => (
                <Button
                  variant="ghost"
                  className="px-2"
                  onClick={() => redeliver.mutate(row.id)}
                  aria-label={t("webhooks.redeliver")}
                >
                  <Redo2 className="h-4 w-4" />
                </Button>
              )
            : undefined
        }
      />
      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={
          selected === "new"
            ? t("webhooks.addTitle")
            : (current?.name ?? "Webhook")
        }
      >
        {revealed ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">{t("webhooks.copyOnce")}</p>
            <div className="break-all rounded-xl bg-slate-950 p-4 font-mono text-xs text-emerald-300">
              {revealed}
            </div>
            <Button
              onClick={() => void navigator.clipboard.writeText(revealed)}
            >
              {t("webhooks.copySecret")}
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              save.mutate(new FormData(event.currentTarget));
            }}
          >
            <div>
              <Label htmlFor="webhook-name">{t("common.name")}</Label>
              <Input
                id="webhook-name"
                name="name"
                defaultValue={current?.name}
                disabled={!editable}
                required
              />
            </div>
            {!current && (
              <div>
                <Label htmlFor="webhook-url">{t("webhooks.httpsUrl")}</Label>
                <Input
                  id="webhook-url"
                  name="url"
                  type="url"
                  placeholder={t("webhooks.urlPlaceholder")}
                  disabled={!editable}
                  required
                />
              </div>
            )}
            <label className="flex gap-2">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={current ? Boolean(current.enabled) : true}
                disabled={!editable}
              />
              {t("webhooks.enabled")}
            </label>
            <fieldset disabled={!editable}>
              <legend className="mb-2 text-sm font-medium">
                {t("webhooks.events")}
              </legend>
              <div className="max-h-52 space-y-2 overflow-y-auto rounded-xl border p-3">
                {events.data?.items.map((event) => (
                  <label key={event} className="flex gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="eventTypes"
                      value={event}
                      defaultChecked={current?.eventTypes.includes(event)}
                    />
                    {event}
                  </label>
                ))}
              </div>
            </fieldset>
            {!current && (
              <div>
                <Label htmlFor="webhook-password">
                  {t("common.confirmPassword")}
                </Label>
                <PasswordInput
                  id="webhook-password"
                  name="password"
                  autoComplete="current-password"
                  required
                />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setSelected(null)}
              >
                {t("common.cancel")}
              </Button>
              {current && canUpdate && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    action.mutate({ id: current.id, action: "rotate-secret" })
                  }
                >
                  <RotateCw className="h-4 w-4" />
                  {t("webhooks.rotate")}
                </Button>
              )}
              {editable && (
                <Button busy={save.isPending}>{t("common.save")}</Button>
              )}
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
