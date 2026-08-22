import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DataTable } from "../../components/ui/data-table.js";
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
import {
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";

type Group = {
  id: string;
  name: string;
  isAdmin: boolean | number;
  memberCount: number;
  permissionKeys: string[];
};
type Permission = { id: string; key: string };

export default function GroupsPage() {
  const { locale, t } = useI18n();
  const canCreate = can("core.group.create");
  const canUpdate = can("core.group.update");
  const canDelete = can("core.group.delete");
  const groupName = (group: Group) =>
    group.id === "grp_administrators" ? t("groups.administrators") : group.name;
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Group | "new" | null>(null);
  const groups = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<{ items: Group[] }>("/api/v1/groups"),
  });
  const permissions = useQuery({
    queryKey: ["permissions"],
    queryFn: () => api<{ items: Permission[] }>("/api/v1/permissions"),
  });
  const rows = useMemo(
    () =>
      (groups.data?.items ?? []).filter((group) =>
        groupName(group).toLowerCase().includes(search.toLowerCase()),
      ),
    [groups.data, locale, search],
  );
  const save = useMutation({
    mutationFn: ({
      id,
      name,
      permissionKeys,
    }: {
      id?: string;
      name: string;
      permissionKeys: string[];
    }) =>
      api(id ? `/api/v1/groups/${id}` : "/api/v1/groups", {
        method: id ? "PATCH" : "POST",
        headers: { "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify({ name, permissionKeys }),
      }),
    onSuccess: () => {
      toast.success(t("groups.saved"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["groups"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api(`/api/v1/groups/${id}`, {
        method: "DELETE",
        headers: await recentReauthHeaders(t("groups.deletePassword")),
      }),
    onSuccess: () => {
      toast.success(t("groups.deleted"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["groups"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const group = selected === "new" ? null : selected;
  const editable =
    selected === "new"
      ? canCreate
      : Boolean(group && !group.isAdmin && canUpdate);
  return (
    <>
      <PageHeader
        title={t("nav.groups")}
        description={t("groups.description")}
        action={
          canCreate ? (
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
          placeholder={t("groups.search")}
          aria-label={t("groups.search")}
        />
      </div>
      {groups.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <DataTable
          rows={rows}
          onOpen={setSelected}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              className: "w-1/3",
              render: (row) => (
                <span className="font-medium">{groupName(row)}</span>
              ),
            },
            {
              key: "members",
              label: t("groups.members"),
              className: "w-28",
              render: (row) => row.memberCount,
            },
            {
              key: "permissions",
              label: t("groups.permissions"),
              render: (row) =>
                t("groups.permissionCount", {
                  count: row.permissionKeys.length,
                }),
            },
            {
              key: "type",
              label: t("groups.type"),
              className: "w-36",
              render: (row) => (
                <Badge tone={Boolean(row.isAdmin) ? "warning" : "neutral"}>
                  {t(
                    Boolean(row.isAdmin) ? "groups.protected" : "groups.custom",
                  )}
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
                        aria-label={`${t("common.edit")} ${groupName(row)}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        variant="ghost"
                        disabled={Boolean(row.isAdmin)}
                        className="px-2 text-red-600"
                        onClick={() =>
                          confirm(
                            t("groups.deleteConfirm", {
                              name: groupName(row),
                            }),
                          ) && remove.mutate(row.id)
                        }
                        aria-label={`${t("common.delete")} ${groupName(row)}`}
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
      <Modal
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={
          selected === "new"
            ? t("groups.addTitle")
            : group
              ? groupName(group)
              : t("groups.group")
        }
        description={
          group?.isAdmin
            ? t("groups.protectedDescription")
            : t("groups.formDescription")
        }
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const input = {
              name: String(form.get("name")),
              permissionKeys: form.getAll("permissions").map(String),
            };
            save.mutate(group ? { ...input, id: group.id } : input);
          }}
        >
          <div>
            <Label htmlFor="group-name">{t("common.name")}</Label>
            <Input
              id="group-name"
              name="name"
              defaultValue={group ? groupName(group) : undefined}
              disabled={!editable}
              required
            />
          </div>
          <fieldset disabled={!editable}>
            <legend className="mb-2 text-sm font-medium">
              {t("groups.permissions")}
            </legend>
            <PermissionChecklist
              permissions={permissions.data?.items ?? []}
              name="permissions"
              defaultSelectedKeys={group?.permissionKeys ?? []}
            />
          </fieldset>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setSelected(null)}
            >
              {t("common.close")}
            </Button>
            {editable && (
              <Button busy={save.isPending}>{t("common.save")}</Button>
            )}
          </div>
        </form>
      </Modal>
    </>
  );
}
