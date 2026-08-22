import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MailPlus, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../components/ui/configurable-data-table.js";
import { DataTable } from "../../components/ui/data-table.js";
import { Modal } from "../../components/ui/modal.js";
import {
  Badge,
  Button,
  Input,
  Label,
  PageHeader,
  PasswordInput,
  Select,
  Skeleton,
  Textarea,
} from "../../components/ui/index.js";
import {
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";
import { can } from "../../lib/ability.js";

type Group = { id: string; name: string };
type ProfileOption = { value: string; usageCount: number };
type User = {
  id: string;
  name: string;
  email: string;
  active: boolean | number;
  status: "active" | "inactive" | "pending";
  phone?: string | null;
  telegramId?: string | null;
  jobTitle?: string | null;
  birthDate?: string | null;
  cpf?: string | null;
  tags: string[];
  sectors: string[];
  notes?: string | null;
  schedule?: WeekSchedule | null;
  groups: Group[];
  createdAt: string | number;
};
type WeekSchedule = {
  dailyHours: string[];
  entryTimes: string[];
  effectiveAt?: string | number;
};
type ScheduleVersion = Omit<WeekSchedule, "effectiveAt"> & {
  id: string;
  effectiveAt: string | number;
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

const weekDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const defaultDailyHours = [
  "08:00",
  "08:00",
  "08:00",
  "08:00",
  "08:00",
  "00:00",
  "00:00",
];
const defaultEntryTimes = ["", "", "", "", "", "", ""];

const weeklyTotal = (hours: string[]) => {
  const minutes = hours.reduce((total, value) => {
    const [hour = "0", minute = "0"] = value.split(":");
    return total + Number(hour) * 60 + Number(minute);
  }, 0);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};

function ChipInput({
  name,
  initialValues,
  options,
  disabled,
  addLabel,
  searchPlaceholder,
  createLabel,
  emptyLabel,
  tone,
}: {
  name: string;
  initialValues: string[];
  options: ProfileOption[];
  disabled: boolean;
  addLabel: string;
  searchPlaceholder: string;
  createLabel: (value: string) => string;
  emptyLabel: string;
  tone: "tag" | "sector";
}) {
  const [values, setValues] = useState(initialValues);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedDraft = draft.trim().toLocaleLowerCase("pt-BR");
  const selectedKeys = new Set(
    values.map((value) => value.toLocaleLowerCase("pt-BR")),
  );
  const matchingOptions = options.filter(
    (option) =>
      !selectedKeys.has(option.value.toLocaleLowerCase("pt-BR")) &&
      (!normalizedDraft ||
        option.value.toLocaleLowerCase("pt-BR").includes(normalizedDraft)),
  );
  const exactOption = options.find(
    (option) => option.value.toLocaleLowerCase("pt-BR") === normalizedDraft,
  );
  const canCreate = Boolean(normalizedDraft && !exactOption);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  const select = (value: string) => {
    if (
      !values.some(
        (item) =>
          item.toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR"),
      )
    )
      setValues((current) => [...current, value]);
    setDraft("");
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {values.map((value) => (
          <span
            key={value}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
              tone === "tag"
                ? "bg-emerald-50 text-emerald-700"
                : "bg-sky-50 text-sky-700"
            }`}
          >
            {value}
            {!disabled && (
              <button
                type="button"
                aria-label={`${addLabel}: ${value}`}
                onClick={() =>
                  setValues((current) =>
                    current.filter((item) => item !== value),
                  )
                }
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <input type="hidden" name={name} value={value} />
          </span>
        ))}
        {!disabled && (
          <div className="relative">
            <button
              type="button"
              className="grid h-9 w-9 place-items-center rounded-full border border-dashed border-slate-300 text-slate-500 hover:bg-slate-50"
              onClick={() => {
                setOpen((current) => !current);
                setTimeout(() => searchRef.current?.focus(), 0);
              }}
              aria-label={addLabel}
              aria-expanded={open}
            >
              <Plus className="h-4 w-4" />
            </button>
            {open && (
              <div className="absolute left-0 top-full z-30 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
                <div className="p-2">
                  <div className="relative">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                    <input
                      ref={searchRef}
                      className="h-9 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm outline-none placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                      value={draft}
                      maxLength={60}
                      placeholder={searchPlaceholder}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setOpen(false);
                          return;
                        }
                        if (event.key === "Enter" && draft.trim()) {
                          event.preventDefault();
                          select(exactOption?.value ?? draft.trim());
                        }
                      }}
                    />
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto border-t border-slate-100 py-1">
                  {matchingOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="flex w-full items-center justify-between gap-4 px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => select(option.value)}
                    >
                      <span className="truncate">{option.value}</span>
                      <span className="text-xs text-slate-500">
                        {option.usageCount}
                      </span>
                    </button>
                  ))}
                  {canCreate && (
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm font-medium text-indigo-600 hover:bg-indigo-50"
                      onClick={() => select(draft.trim())}
                    >
                      {createLabel(draft.trim())}
                    </button>
                  )}
                  {!matchingOptions.length && !canCreate && (
                    <p className="px-3 py-4 text-center text-sm text-slate-500">
                      {emptyLabel}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

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
  const [userTab, setUserTab] = useState<"general" | "schedule" | "history">(
    "general",
  );
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
  const profileOptions = useQuery({
    queryKey: ["user-profile-options"],
    queryFn: () =>
      api<{ tags: ProfileOption[]; sectors: ProfileOption[] }>(
        "/api/v1/users/profile-options",
      ),
  });
  const invitations = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api<{ items: Invitation[] }>("/api/v1/invitations"),
  });
  const scheduleHistory = useQuery({
    queryKey: ["user-schedule-history", current?.id],
    queryFn: () =>
      api<{ items: ScheduleVersion[] }>(
        `/api/v1/users/${current!.id}/schedule-history`,
      ),
    enabled: Boolean(current && userTab === "history"),
  });
  useEffect(() => setUserTab("general"), [selected]);
  const remove = useMutation({
    mutationFn: async (id: string) =>
      api(`/api/v1/users/${id}`, {
        method: "DELETE",
        headers: await recentReauthHeaders(t("users.removePassword")),
      }),
    onSuccess: () => {
      toast.success(t("users.removed"));
      void client.invalidateQueries({ queryKey: ["users"] });
      void client.invalidateQueries({ queryKey: ["user-profile-options"] });
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
      status,
      phone,
      telegramId,
      jobTitle,
      birthDate,
      cpf,
      tags,
      sectors,
      notes,
      schedule,
    }: {
      id?: string;
      name: string;
      email: string;
      password?: string;
      active: boolean;
      groupIds?: string[];
      status: User["status"];
      phone?: string;
      telegramId?: string;
      jobTitle?: string;
      birthDate?: string;
      cpf?: string;
      tags: string[];
      sectors: string[];
      notes?: string;
      schedule: WeekSchedule;
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
          status,
          phone,
          telegramId,
          jobTitle,
          birthDate,
          cpf,
          tags,
          sectors,
          notes,
          schedule,
        }),
      });
    },
    onSuccess: (_data, variables) => {
      toast.success(t(variables.id ? "users.updated" : "users.created"));
      void client.invalidateQueries({ queryKey: ["users"] });
      void client.invalidateQueries({ queryKey: ["user-profile-options"] });
      void client.invalidateQueries({ queryKey: ["me", "ability"] });
      void client.invalidateQueries({ queryKey: ["user-schedule-history"] });
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
        <ConfigurableDataTable
          tableId="core.users"
          rows={rows}
          onOpen={setSelected}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              size: 240,
              minSize: 140,
              sortValue: (row) => row.name,
              render: (row) => <span className="font-medium">{row.name}</span>,
            },
            {
              key: "email",
              label: t("common.email"),
              size: 320,
              minSize: 180,
              sortValue: (row) => row.email,
              render: (row) => row.email,
            },
            {
              key: "groups",
              label: t("users.groups"),
              size: 260,
              minSize: 140,
              sortValue: (row) => row.groups.map(groupName).join(", ") || "—",
              render: (row) => row.groups.map(groupName).join(", ") || "—",
            },
            {
              key: "status",
              label: t("common.status"),
              size: 140,
              minSize: 110,
              maxSize: 240,
              sortValue: (row) => row.status,
              render: (row) => (
                <Badge
                  tone={
                    row.status === "active"
                      ? "success"
                      : row.status === "pending"
                        ? "warning"
                        : "danger"
                  }
                >
                  {t(`users.status.${row.status}`)}
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
        contentClassName="sm:max-w-6xl"
      >
        {selected !== null && (
          <form
            key={current?.id ?? "new-user"}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const status = String(form.get("status")) as User["status"];
              save.mutate({
                ...(current ? { id: current.id } : {}),
                name: String(form.get("name")),
                email: String(form.get("email")),
                active: status === "active",
                status,
                phone: String(form.get("phone") ?? ""),
                telegramId: String(form.get("telegramId") ?? ""),
                jobTitle: String(form.get("jobTitle") ?? ""),
                birthDate: String(form.get("birthDate") ?? ""),
                cpf: String(form.get("cpf") ?? "").replace(/\D/gu, ""),
                tags: form.getAll("tags").map(String),
                sectors: form.getAll("sectors").map(String),
                notes: String(form.get("notes") ?? ""),
                schedule: {
                  dailyHours: weekDays.map((day) =>
                    String(form.get(`dailyHours-${day}`)),
                  ),
                  entryTimes: weekDays.map((day) =>
                    String(form.get(`entryTime-${day}`) ?? ""),
                  ),
                },
                ...(String(form.get("password") ?? "")
                  ? { password: String(form.get("password")) }
                  : {}),
                ...(canReadGroups
                  ? { groupIds: form.getAll("groups").map(String) }
                  : {}),
              });
            }}
          >
            <div className="-mx-5 mb-5 flex gap-1 border-b px-5" role="tablist">
              {(["general", "schedule", "history"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={userTab === tab}
                  disabled={tab === "history" && !current}
                  className={`border-b-2 px-4 py-3 text-sm font-semibold transition ${
                    userTab === tab
                      ? "border-indigo-600 text-indigo-600"
                      : "border-transparent text-slate-500 hover:text-slate-800"
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                  onClick={() => setUserTab(tab)}
                >
                  {t(`users.tabs.${tab}`)}
                </button>
              ))}
            </div>

            <section className={userTab === "general" ? "space-y-5" : "hidden"}>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div>
                  <Label htmlFor="user-name">{t("common.name")} *</Label>
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
                  <Label htmlFor="user-email">{t("common.email")} *</Label>
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
                    placeholder={
                      current ? t("users.passwordUnchanged") : undefined
                    }
                  />
                </div>
                <div>
                  <Label htmlFor="user-phone">{t("users.phone")}</Label>
                  <Input
                    id="user-phone"
                    name="phone"
                    type="tel"
                    maxLength={40}
                    defaultValue={current?.phone ?? ""}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label htmlFor="user-telegram">{t("users.telegramId")}</Label>
                  <Input
                    id="user-telegram"
                    name="telegramId"
                    maxLength={64}
                    defaultValue={current?.telegramId ?? ""}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label htmlFor="user-job-title">{t("users.jobTitle")}</Label>
                  <Input
                    id="user-job-title"
                    name="jobTitle"
                    maxLength={120}
                    defaultValue={current?.jobTitle ?? ""}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label htmlFor="user-birth-date">
                    {t("users.birthDate")}
                  </Label>
                  <Input
                    id="user-birth-date"
                    name="birthDate"
                    type="date"
                    defaultValue={current?.birthDate ?? ""}
                    disabled={!editable}
                  />
                </div>
                <div>
                  <Label htmlFor="user-cpf">{t("users.cpf")}</Label>
                  <Input
                    id="user-cpf"
                    name="cpf"
                    inputMode="numeric"
                    pattern="[0-9]{11}"
                    maxLength={11}
                    defaultValue={current?.cpf ?? ""}
                    disabled={!editable}
                  />
                </div>
              </div>

              <fieldset disabled={!editable || !canReadGroups}>
                <legend className="mb-2 text-sm font-medium text-slate-700">
                  {t("users.permissionGroups")}
                </legend>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {groups.data?.items.map((group) => (
                    <label
                      key={group.id}
                      className="flex items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        name="groups"
                        value={group.id}
                        defaultChecked={Boolean(
                          current?.groups.some((item) => item.id === group.id),
                        )}
                      />
                      {groupName(group)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <Label>{t("users.tags")}</Label>
                  <ChipInput
                    name="tags"
                    initialValues={current?.tags ?? []}
                    options={profileOptions.data?.tags ?? []}
                    disabled={!editable}
                    addLabel={t("users.addTag")}
                    searchPlaceholder={t("users.searchOrCreateTag")}
                    createLabel={(value) => t("users.createOption", { value })}
                    emptyLabel={t("users.noProfileOptions")}
                    tone="tag"
                  />
                </div>
                <div>
                  <Label>{t("users.sectors")}</Label>
                  <ChipInput
                    name="sectors"
                    initialValues={current?.sectors ?? []}
                    options={profileOptions.data?.sectors ?? []}
                    disabled={!editable}
                    addLabel={t("users.addSector")}
                    searchPlaceholder={t("users.searchOrCreateSector")}
                    createLabel={(value) => t("users.createOption", { value })}
                    emptyLabel={t("users.noProfileOptions")}
                    tone="sector"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="user-notes">
                  {t("users.notes")}{" "}
                  <span className="text-xs text-slate-500">
                    ({t("users.adminOnly")})
                  </span>
                </Label>
                <Textarea
                  id="user-notes"
                  name="notes"
                  maxLength={5000}
                  defaultValue={current?.notes ?? ""}
                  disabled={!editable}
                  placeholder={t("users.notesPlaceholder")}
                />
              </div>
              <div>
                <Label htmlFor="user-status">{t("common.status")}</Label>
                <Select
                  id="user-status"
                  name="status"
                  defaultValue={current?.status ?? "active"}
                  disabled={!editable}
                >
                  <option value="active">{t("users.status.active")}</option>
                  <option value="inactive">{t("users.status.inactive")}</option>
                  <option value="pending">{t("users.status.pending")}</option>
                </Select>
              </div>
            </section>

            <section
              className={userTab === "schedule" ? "space-y-5" : "hidden"}
            >
              <div>
                <h3 className="mb-3 text-sm font-semibold">
                  {t("users.dailyHours")}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                  {weekDays.map((day, index) => (
                    <div key={`daily-${day}`}>
                      <Label htmlFor={`daily-${day}`}>
                        {t(`users.days.${day}`)}
                      </Label>
                      <Input
                        id={`daily-${day}`}
                        name={`dailyHours-${day}`}
                        type="time"
                        defaultValue={
                          current?.schedule?.dailyHours[index] ??
                          defaultDailyHours[index]
                        }
                        disabled={!editable}
                        required
                      />
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="mb-3 text-sm font-semibold">
                  {t("users.entryTime")}
                </h3>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                  {weekDays.map((day, index) => (
                    <div key={`entry-${day}`}>
                      <Label htmlFor={`entry-${day}`}>
                        {t(`users.days.${day}`)}
                      </Label>
                      <Input
                        id={`entry-${day}`}
                        name={`entryTime-${day}`}
                        type="time"
                        defaultValue={
                          current?.schedule?.entryTimes[index] ??
                          defaultEntryTimes[index]
                        }
                        disabled={!editable}
                      />
                    </div>
                  ))}
                </div>
              </div>
              <p className="border-t pt-4 text-xs text-slate-500">
                {t("users.scheduleHelp")}
              </p>
            </section>

            <section className={userTab === "history" ? "space-y-4" : "hidden"}>
              <p className="text-xs text-slate-500">{t("users.historyHelp")}</p>
              {scheduleHistory.isPending ? (
                <Skeleton className="h-36" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[760px] text-left text-sm">
                    <thead className="border-b text-xs uppercase text-slate-500">
                      <tr>
                        <th className="py-3 pr-3">{t("users.effective")}</th>
                        {weekDays.map((day) => (
                          <th key={day} className="px-2 py-3">
                            {t(`users.days.${day}`)}
                          </th>
                        ))}
                        <th className="px-2 py-3">{t("users.weekTotal")}</th>
                        <th className="pl-2 py-3">{t("users.registered")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(scheduleHistory.data?.items ?? []).map(
                        (version, index) => (
                          <tr key={version.id} className="border-b">
                            <td className="py-3 pr-3 font-medium">
                              {index === scheduleHistory.data!.items.length - 1
                                ? t("users.initial")
                                : formatDateTime(version.effectiveAt)}
                            </td>
                            {version.dailyHours.map((hours, dayIndex) => (
                              <td
                                key={`${version.id}-${dayIndex}`}
                                className="px-2 py-3"
                              >
                                {hours}
                              </td>
                            ))}
                            <td className="px-2 py-3 font-semibold">
                              {weeklyTotal(version.dailyHours)}
                            </td>
                            <td className="pl-2 py-3 text-slate-500">
                              {formatDateTime(version.createdAt)}
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                  {!scheduleHistory.data?.items.length && (
                    <p className="py-8 text-center text-sm text-slate-500">
                      {t("users.noScheduleHistory")}
                    </p>
                  )}
                </div>
              )}
            </section>

            <div className="-mx-5 -mb-5 mt-6 flex justify-end gap-2 border-t px-5 py-4">
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
