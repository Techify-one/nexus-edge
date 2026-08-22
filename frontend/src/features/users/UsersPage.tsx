import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus, Pencil, Plus, Search, Trash2 } from "lucide-react";
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
  PasswordInput,
  Skeleton,
} from "../../components/ui/index.js";
import {
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";

type Group = { id: string; name: string };
type User = {
  id: string;
  name: string;
  email: string;
  active: boolean | number;
  groups: Group[];
  createdAt: string | number;
};
type Invitation = {
  id: string;
  email: string;
  expiresAt: string | number;
  usedAt?: string | number | null;
  revokedAt?: string | number | null;
  createdAt: string | number;
};

export default function UsersPage() {
  const { t, formatDateTime } = useI18n();
  const canCreate = can("core.user.create");
  const canUpdate = can("core.user.update");
  const canDelete = can("core.user.delete");
  const canReadGroups = can("core.group.read");
  const groupName = (group: Group) =>
    group.id === "grp_administrators" ? t("groups.administrators") : group.name;
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<User | "new" | null>(null);
  const [selectedInvitation, setSelectedInvitation] =
    useState<Invitation | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const current = selected === "new" ? null : selected;
  const editable = selected === "new" ? canCreate : canUpdate;
  const users = useQuery({
    queryKey: ["users", search],
    queryFn: () =>
      api<{ items: User[] }>(
        `/api/v1/users?limit=100&search=${encodeURIComponent(search)}`,
      ),
  });
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<{ items: Group[] }>("/api/v1/groups"),
    enabled: canReadGroups,
  });
  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api<{ items: Invitation[] }>("/api/v1/invitations"),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api(`/api/v1/users/${id}`, {
        method: "DELETE",
        headers: await recentReauthHeaders(t("users.removePassword")),
      }),
    onSuccess: () => {
      toast.success(t("users.removed"));
      void client.invalidateQueries({ queryKey: ["users"] });
      setSelected(null);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const save = useMutation({
    mutationFn: async ({
      id,
      name,
      email,
      password,
      active,
      groupIds,
    }: {
      id?: string;
      name: string;
      email: string;
      password?: string;
      active: boolean;
      groupIds?: string[];
    }) => {
      const headers: Record<string, string> = {
        "Idempotency-Key": idempotencyKey(),
      };
      if (id && password)
        Object.assign(
          headers,
          await recentReauthHeaders(t("users.changePasswordConfirmation")),
        );
      return api(id ? `/api/v1/users/${id}` : "/api/v1/users", {
        method: id ? "PATCH" : "POST",
        headers,
        body: JSON.stringify({
          name,
          email,
          password,
          active,
          groupIds,
        }),
      });
    },
    onSuccess: (_data, variables) => {
      toast.success(t(variables.id ? "users.updated" : "users.created"));
      void client.invalidateQueries({ queryKey: ["users"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
      setSelected(null);
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const invite = useMutation({
    mutationFn: (form: FormData) =>
      api<{ inviteUrl: string }>("/api/v1/invitations", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify({
          email: form.get("email"),
          groupIds: form.getAll("groups"),
          expiresInHours: 48,
        }),
      }),
    onSuccess: async (data) => {
      await navigator.clipboard.writeText(data.inviteUrl);
      toast.success(t("users.inviteCreated"));
      setInviteOpen(false);
      void client.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const revokeInvitation = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/invitations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(t("users.inviteRevoked"));
      setSelectedInvitation(null);
      void client.invalidateQueries({ queryKey: ["invitations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const rows = users.data?.items ?? [];
  return (
    <>
      <PageHeader
        title={t("nav.users")}
        description={t("users.description")}
        action={
          canCreate ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => setInviteOpen(true)}>
                <MailPlus className="h-4 w-4" />
                {t("users.inviteAction")}
              </Button>
              <Button onClick={() => setSelected("new")}>
                <Plus className="h-4 w-4" />
                {t("common.add")}
              </Button>
            </div>
          ) : undefined
        }
      />
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-10"
          placeholder={t("users.search")}
          aria-label={t("users.search")}
        />
      </div>
      {users.isPending ? (
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
              key: "email",
              label: t("common.email"),
              className: "w-1/3",
              render: (row) => row.email,
            },
            {
              key: "groups",
              label: t("users.groups"),
              render: (row) => row.groups.map(groupName).join(", ") || "—",
            },
            {
              key: "status",
              label: t("common.status"),
              className: "w-24",
              render: (row) => (
                <Badge tone={Boolean(row.active) ? "success" : "danger"}>
                  {t(Boolean(row.active) ? "common.active" : "common.inactive")}
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
                        aria-label={`${t("common.edit")} ${row.name}`}
                        onClick={() => setSelected(row)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        className="px-2 text-red-600"
                        aria-label={`${t("common.delete")} ${row.name}`}
                        onClick={() =>
                          confirm(
                            t("users.removeConfirm", { name: row.name }),
                          ) && remove.mutate(row.id)
                        }
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
        {t("users.recentInvites")}
      </h2>
      {invitations.isPending ? (
        <Skeleton className="h-48" />
      ) : (
        <DataTable
          rows={invitations.data?.items ?? []}
          onOpen={setSelectedInvitation}
          emptyTitle={t("users.noInvites")}
          emptyDescription={t("users.noInvitesDescription")}
          columns={[
            {
              key: "email",
              label: t("common.email"),
              render: (row) => <span className="font-medium">{row.email}</span>,
            },
            {
              key: "created",
              label: t("common.created"),
              className: "w-44",
              render: (row) => formatDateTime(row.createdAt),
            },
            {
              key: "expires",
              label: t("common.expires"),
              className: "w-44",
              render: (row) => formatDateTime(row.expiresAt),
            },
            {
              key: "status",
              label: t("common.status"),
              className: "w-28",
              render: (row) => {
                const status = row.usedAt
                  ? "common.used"
                  : row.revokedAt
                    ? "common.revoked"
                    : new Date(row.expiresAt).getTime() <= Date.now()
                      ? "common.expired"
                      : "common.pending";
                return (
                  <Badge
                    tone={status === "common.pending" ? "warning" : "neutral"}
                  >
                    {t(status)}
                  </Badge>
                );
              },
            },
          ]}
          actions={
            canDelete
              ? (row) => (
                  <Button
                    variant="ghost"
                    className="px-2 text-red-600"
                    disabled={Boolean(row.usedAt || row.revokedAt)}
                    onClick={() =>
                      confirm(t("users.revokeConfirm", { email: row.email })) &&
                      revokeInvitation.mutate(row.id)
                    }
                    aria-label={`${t("common.delete")} ${row.email}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )
              : undefined
          }
        />
      )}
      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={selected === "new" ? t("users.addTitle") : (current?.name ?? "")}
        description={
          selected === "new" ? t("users.createDescription") : current?.email
        }
      >
        {selected !== null && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              save.mutate({
                ...(current ? { id: current.id } : {}),
                name: String(form.get("name")),
                email: String(form.get("email")),
                active: form.get("active") === "on",
                ...(String(form.get("password") ?? "")
                  ? { password: String(form.get("password")) }
                  : {}),
                ...(canReadGroups
                  ? { groupIds: form.getAll("groups").map(String) }
                  : {}),
              });
            }}
          >
            <div>
              <Label htmlFor="user-name">{t("common.name")}</Label>
              <Input
                id="user-name"
                name="name"
                defaultValue={current?.name ?? ""}
                minLength={2}
                maxLength={120}
                disabled={!editable}
                required
              />
            </div>
            <div>
              <Label htmlFor="user-email">{t("common.email")}</Label>
              <Input
                id="user-email"
                name="email"
                type="email"
                defaultValue={current?.email ?? ""}
                disabled={!editable}
                required
              />
            </div>
            <div>
              <Label htmlFor="user-password">
                {t(current ? "users.newPassword" : "common.password")}
              </Label>
              <PasswordInput
                id="user-password"
                name="password"
                minLength={8}
                maxLength={200}
                autoComplete="new-password"
                disabled={!editable}
                required={!current}
                placeholder={current ? t("users.passwordUnchanged") : undefined}
              />
              <p className="mt-1 text-xs text-slate-500">
                {t(current ? "users.passwordHelp" : "auth.passwordMin")}
              </p>
            </div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="active"
                defaultChecked={current ? Boolean(current.active) : true}
                disabled={!editable}
              />{" "}
              {t("users.active")}
            </label>
            <fieldset disabled={!editable || !canReadGroups}>
              <legend className="mb-2 text-sm font-medium">
                {t("users.groups")}
              </legend>
              <div className="space-y-2">
                {groups.data?.items.map((group) => (
                  <label key={group.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="groups"
                      value={group.id}
                      defaultChecked={Boolean(
                        current?.groups.some(
                          (current) => current.id === group.id,
                        ),
                      )}
                    />
                    {groupName(group)}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setSelected(null)}
              >
                {t(editable ? "common.cancel" : "common.close")}
              </Button>
              {editable && (
                <Button busy={save.isPending}>
                  {t(current ? "common.save" : "common.add")}
                </Button>
              )}
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(selectedInvitation)}
        onOpenChange={(open) => {
          if (!open) setSelectedInvitation(null);
        }}
        title={t("users.invite")}
        description={selectedInvitation?.email}
      >
        {selectedInvitation && (
          <div className="space-y-4 text-sm">
            <p>
              <strong>{t("common.created")}:</strong>{" "}
              {formatDateTime(selectedInvitation.createdAt)}
            </p>
            <p>
              <strong>{t("common.expires")}:</strong>{" "}
              {formatDateTime(selectedInvitation.expiresAt)}
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setSelectedInvitation(null)}
              >
                {t("common.close")}
              </Button>
              {canDelete &&
                !selectedInvitation.usedAt &&
                !selectedInvitation.revokedAt && (
                  <Button
                    variant="danger"
                    onClick={() =>
                      revokeInvitation.mutate(selectedInvitation.id)
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("users.revoke")}
                  </Button>
                )}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title={t("users.invite")}
        description={t("users.addDescription")}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            invite.mutate(new FormData(event.currentTarget));
          }}
        >
          <div>
            <Label htmlFor="invite-email">{t("common.email")}</Label>
            <Input id="invite-email" name="email" type="email" required />
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">
              {t("users.initialGroups")}
            </legend>
            <div className="space-y-2">
              {groups.data?.items.map((group) => (
                <label key={group.id} className="flex items-center gap-2">
                  <input type="checkbox" name="groups" value={group.id} />
                  {groupName(group)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setInviteOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button busy={invite.isPending}>{t("users.createInvite")}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
