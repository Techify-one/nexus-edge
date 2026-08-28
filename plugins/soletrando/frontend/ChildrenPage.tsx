import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../../frontend/src/components/ui/configurable-data-table.js";
import { Modal } from "../../../frontend/src/components/ui/modal.js";
import {
  Button,
  Card,
  DataValue,
  Input,
  Label,
  MetricCard,
  PageHeader,
  Select,
  Skeleton,
} from "../../../frontend/src/components/ui/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import {
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../../frontend/src/lib/api/core-client.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  type TranscriptionModel,
} from "../src/transcription-models.js";
import type { ChildSummary, Overview, TranscriptionSettings } from "./types.js";

const childLink = (token: string): string =>
  `${window.location.origin}/soletrando/c/${token}`;

export default function ChildrenPage() {
  const { t, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ChildSummary | "new" | null>(null);
  const [transcriptionModel, setTranscriptionModel] =
    useState<TranscriptionModel>(DEFAULT_TRANSCRIPTION_MODEL);
  const current = selected === "new" ? null : selected;
  const canReadSettings = can("soletrando.settings.read");
  const canUpdateSettings = can("soletrando.settings.update");
  const overview = useQuery({
    queryKey: ["soletrando", "overview", search],
    queryFn: () =>
      api<Overview>(
        `/api/v1/p/soletrando/overview?search=${encodeURIComponent(search)}`,
      ),
  });
  const settings = useQuery({
    queryKey: ["soletrando", "settings", "transcription"],
    queryFn: () =>
      api<TranscriptionSettings>("/api/v1/p/soletrando/settings/transcription"),
    enabled: canReadSettings,
  });
  useEffect(() => {
    if (settings.data) setTranscriptionModel(settings.data.transcriptionModel);
  }, [settings.data]);
  const updateSettings = useMutation({
    mutationFn: (model: TranscriptionModel) =>
      api<TranscriptionSettings>(
        "/api/v1/p/soletrando/settings/transcription",
        {
          method: "PUT",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify({ transcriptionModel: model }),
        },
      ),
    onSuccess: (data) => {
      client.setQueryData(["soletrando", "settings", "transcription"], data);
      toast.success(t("soletrando.settings.saved"));
    },
    onError: (cause: Error) => toast.error(cause.message),
  });
  const save = useMutation({
    mutationFn: (name: string) =>
      api<{ child: ChildSummary }>(
        current
          ? `/api/v1/p/soletrando/children/${current.id}`
          : "/api/v1/p/soletrando/children",
        {
          method: current ? "PATCH" : "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
          body: JSON.stringify(
            current ? { name, version: current.version } : { name },
          ),
        },
      ),
    onSuccess: () => {
      toast.success(t("soletrando.childSaved"));
      setSelected(null);
      void client.invalidateQueries({ queryKey: ["soletrando"] });
    },
    onError: (cause: Error) => toast.error(cause.message),
  });
  const remove = useMutation({
    mutationFn: async (child: ChildSummary) =>
      api(`/api/v1/p/soletrando/children/${child.id}`, {
        method: "DELETE",
        headers: await recentReauthHeaders(t("soletrando.deleteChild")),
      }),
    onSuccess: () => {
      toast.success(t("soletrando.childDeleted"));
      void client.invalidateQueries({ queryKey: ["soletrando"] });
    },
    onError: (cause: Error) => toast.error(cause.message),
  });
  const rotate = useMutation({
    mutationFn: (child: ChildSummary) =>
      api<{ token: string }>(
        `/api/v1/p/soletrando/children/${child.id}/rotate-link`,
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey() },
        },
      ),
    onSuccess: async ({ token }) => {
      await navigator.clipboard.writeText(childLink(token));
      toast.success(t("soletrando.linkRotated"));
      void client.invalidateQueries({ queryKey: ["soletrando"] });
    },
    onError: (cause: Error) => toast.error(cause.message),
  });

  const copy = async (child: ChildSummary) => {
    await navigator.clipboard.writeText(childLink(child.token));
    toast.success(t("soletrando.linkCopied"));
  };
  const totals = overview.data?.totals;

  return (
    <>
      <PageHeader
        title={t("soletrando.title")}
        description={t("soletrando.description")}
        action={
          can("soletrando.child.create") ? (
            <Button onClick={() => setSelected("new")}>
              <Plus className="h-4 w-4" />
              {t("soletrando.addChild")}
            </Button>
          ) : undefined
        }
      />
      {canReadSettings && (
        <Card className="mb-6">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-end">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                {t("soletrando.settings.title")}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                {t("soletrando.settings.description")}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {t(
                  transcriptionModel === "@cf/deepgram/nova-3"
                    ? "soletrando.settings.novaDescription"
                    : "soletrando.settings.whisperDescription",
                )}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div>
                <Label htmlFor="soletrando-transcription-model">
                  {t("soletrando.settings.model")}
                </Label>
                <Select
                  id="soletrando-transcription-model"
                  value={transcriptionModel}
                  disabled={settings.isPending || !canUpdateSettings}
                  onChange={(event) =>
                    setTranscriptionModel(
                      event.target.value as TranscriptionModel,
                    )
                  }
                >
                  <option value="@cf/openai/whisper-large-v3-turbo">
                    {t("soletrando.settings.whisper")}
                  </option>
                  <option value="@cf/deepgram/nova-3">
                    {t("soletrando.settings.nova")}
                  </option>
                </Select>
              </div>
              {canUpdateSettings && (
                <Button
                  type="button"
                  busy={updateSettings.isPending}
                  disabled={
                    settings.isPending ||
                    transcriptionModel === settings.data?.transcriptionModel
                  }
                  onClick={() => updateSettings.mutate(transcriptionModel)}
                >
                  {t("soletrando.settings.save")}
                </Button>
              )}
            </div>
          </div>
        </Card>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("soletrando.children")}
          value={totals?.childrenCount ?? 0}
          tone="accent"
        />
        <MetricCard
          label={t("soletrando.completedSessions")}
          value={totals?.sessionsCount ?? 0}
          tone="success"
        />
        <MetricCard
          label={t("soletrando.averageScore")}
          value={totals?.averageScore ?? 0}
          tone="info"
        />
        <MetricCard
          label={t("soletrando.practicedWords")}
          value={totals?.attemptsCount ?? 0}
          tone="warning"
        />
      </div>
      <div className="relative mb-4 max-w-md">
        <Search className="absolute left-3 top-3 h-5 w-5 text-slate-400" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="pl-10"
          placeholder={t("soletrando.search")}
          aria-label={t("soletrando.search")}
        />
      </div>
      {overview.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <ConfigurableDataTable
          tableId="plugin.soletrando.children"
          rows={overview.data?.children ?? []}
          onOpen={(child) => navigate(`/app/soletrando/children/${child.id}`)}
          columns={[
            {
              key: "name",
              label: t("common.name"),
              render: (child) => (
                <span className="font-medium">{child.name}</span>
              ),
              sortValue: (child) => child.name,
              size: 260,
              minSize: 140,
              maxSize: 600,
            },
            {
              key: "sessions",
              label: t("soletrando.sessions"),
              render: (child) => child.sessionsCount,
              sortValue: (child) => child.sessionsCount,
              size: 150,
              minSize: 110,
              maxSize: 240,
            },
            {
              key: "completed_phases",
              label: t("soletrando.completedPhases"),
              render: (child) => `${child.completedPhases}/4`,
              sortValue: (child) => child.completedPhases,
              size: 180,
              minSize: 120,
              maxSize: 280,
            },
            {
              key: "best_score",
              label: t("soletrando.bestScore"),
              render: (child) =>
                child.bestScore == null ? (
                  "—"
                ) : (
                  <DataValue tone="success">{child.bestScore}</DataValue>
                ),
              sortValue: (child) => child.bestScore ?? -1,
              size: 160,
              minSize: 120,
              maxSize: 260,
            },
            {
              key: "last_activity",
              label: t("soletrando.lastActivity"),
              render: (child) =>
                child.lastActivity
                  ? formatDateTime(child.lastActivity)
                  : t("soletrando.noActivity"),
              sortValue: (child) =>
                child.lastActivity ? new Date(child.lastActivity).getTime() : 0,
              size: 220,
              minSize: 160,
              maxSize: 360,
            },
          ]}
          actions={(child) => (
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                className="px-2"
                onClick={() => void copy(child)}
                aria-label={`${t("soletrando.copyLink")} ${child.name}`}
                title={t("soletrando.copyLink")}
              >
                <Copy className="h-4 w-4" />
              </Button>
              {can("soletrando.child.update") && (
                <>
                  <Button
                    variant="ghost"
                    className="px-2"
                    onClick={() => setSelected(child)}
                    aria-label={`${t("common.edit")} ${child.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    className="px-2"
                    onClick={() =>
                      confirm(t("soletrando.rotateConfirm")) &&
                      rotate.mutate(child)
                    }
                    aria-label={`${t("soletrando.rotateLink")} ${child.name}`}
                    title={t("soletrando.rotateLink")}
                  >
                    <Link2 className="h-4 w-4" />
                  </Button>
                </>
              )}
              {can("soletrando.child.delete") && (
                <Button
                  variant="ghost"
                  className="px-2 text-red-600"
                  onClick={() =>
                    confirm(
                      t("soletrando.deleteConfirm", { name: child.name }),
                    ) && remove.mutate(child)
                  }
                  aria-label={`${t("common.delete")} ${child.name}`}
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
            ? t("soletrando.addChild")
            : t("soletrando.editChild")
        }
        description={t("soletrando.description")}
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            save.mutate(String(form.get("name")));
          }}
        >
          <div>
            <Label htmlFor="soletrando-child-name">
              {t("soletrando.childName")}
            </Label>
            <Input
              id="soletrando-child-name"
              name="name"
              minLength={2}
              maxLength={50}
              defaultValue={current?.name}
              autoComplete="off"
              required
            />
          </div>
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
