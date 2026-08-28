import { useQuery } from "@tanstack/react-query";
import { Mic, Plus, RotateCcw, Settings, Upload } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../../frontend/src/components/ui/configurable-data-table.js";
import {
  Badge,
  Button,
  Input,
  MetricCard,
  PageHeader,
  Select,
  SingleLineFilterBar,
  Skeleton,
} from "../../../frontend/src/components/ui/index.js";
import {
  useI18n,
  type TranslationKey,
} from "../../../frontend/src/i18n/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import { recorderApi } from "./api-client.js";
import { MeetingRecorderRouteGate } from "./MeetingRecorderRouteGate.js";
import { useMeetingRecorderSession } from "./MeetingRecorderSessionProvider.js";
import type { Recording } from "./types.js";

type SortingState = Array<{ id: string; desc: boolean }>;
const statusKeys: Record<string, TranslationKey> = {
  recording: "meetingRecorder.status.recording",
  paused: "meetingRecorder.status.paused",
  interrupted: "meetingRecorder.status.interrupted",
  finalizing: "meetingRecorder.status.finalizing",
  complete: "meetingRecorder.status.complete",
  deleting: "meetingRecorder.status.deleting",
};
const transcriptionKeys: Record<string, TranslationKey> = {
  off: "meetingRecorder.transcription.off",
  pending: "meetingRecorder.transcription.pending",
  processing: "meetingRecorder.transcription.processing",
  ready: "meetingRecorder.transcription.ready",
  partial: "meetingRecorder.transcription.partial",
  quota_wait: "meetingRecorder.transcription.quota_wait",
  failed: "meetingRecorder.transcription.failed",
};

const duration = (value: number) => {
  const total = Math.floor(value / 1_000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};
const bytes = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  }).format(value / 1024 / 1024);
const tone = (status: string): "neutral" | "success" | "warning" | "danger" =>
  status === "complete"
    ? "success"
    : status === "interrupted"
      ? "danger"
      : status === "recording" || status === "paused"
        ? "warning"
        : "neutral";

function HomeContent() {
  const { t, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const session = useMeetingRecorderSession();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "started_at", desc: true },
  ]);
  const [cursor, setCursor] = useState<string | null>(null);
  const sort = sorting[0];
  const queryString = useMemo(() => {
    const query = new URLSearchParams({ limit: "50" });
    if (search.trim()) query.set("search", search.trim());
    if (status) query.set("status", status);
    if (source) query.set("source", source);
    if (sort) {
      query.set("sort", sort.id);
      query.set("direction", sort.desc ? "desc" : "asc");
    }
    if (cursor) query.set("cursor", cursor);
    return query;
  }, [cursor, search, sort, source, status]);
  const overview = useQuery({
    queryKey: ["meeting-recorder", "overview"],
    queryFn: recorderApi.overview,
  });
  const recordings = useQuery({
    queryKey: ["meeting-recorder", "recordings", queryString.toString()],
    queryFn: () => recorderApi.recordings(queryString),
  });
  const changeSorting = useCallback((next: SortingState) => {
    setCursor(null);
    setSorting(next.length ? next : [{ id: "started_at", desc: true }]);
  }, []);
  const columns = useMemo(
    () => [
      {
        key: "title",
        label: t("meetingRecorder.column.title"),
        render: (row: Recording) => (
          <span className="font-medium">{row.title}</span>
        ),
        sortValue: (row: Recording) => row.title,
        size: 260,
        minSize: 160,
        maxSize: 600,
      },
      {
        key: "status",
        label: t("common.status"),
        render: (row: Recording) => (
          <Badge tone={tone(row.effectiveCaptureStatus)}>
            {t(
              statusKeys[row.effectiveCaptureStatus] ??
                "meetingRecorder.status.interrupted",
            )}
          </Badge>
        ),
        sortValue: (row: Recording) => row.effectiveCaptureStatus,
        size: 150,
        minSize: 120,
        maxSize: 240,
      },
      {
        key: "source",
        label: t("meetingRecorder.column.source"),
        render: (row: Recording) =>
          t(`meetingRecorder.source.${row.ingestSource}`),
        sortValue: (row: Recording) => row.ingestSource,
        size: 140,
        minSize: 110,
        maxSize: 220,
      },
      {
        key: "duration",
        label: t("meetingRecorder.column.duration"),
        render: (row: Recording) => duration(row.storedDurationMs),
        sortValue: (row: Recording) => row.storedDurationMs,
        size: 120,
        minSize: 90,
        maxSize: 180,
      },
      {
        key: "size",
        label: t("meetingRecorder.column.size"),
        render: (row: Recording) => bytes(row.totalBytes),
        sortValue: (row: Recording) => row.totalBytes,
        size: 120,
        minSize: 90,
        maxSize: 180,
      },
      {
        key: "transcription",
        label: t("meetingRecorder.column.transcription"),
        render: (row: Recording) =>
          t(
            transcriptionKeys[row.transcriptionStatus] ??
              "meetingRecorder.transcription.pending",
          ),
        sortValue: (row: Recording) => row.transcriptionStatus,
        size: 160,
        minSize: 120,
        maxSize: 260,
      },
      {
        key: "owner",
        label: t("meetingRecorder.column.owner"),
        render: (row: Recording) => row.ownerName ?? "—",
        sortValue: (row: Recording) => row.ownerName ?? "",
        size: 180,
        minSize: 120,
        maxSize: 320,
      },
      {
        key: "started_at",
        label: t("meetingRecorder.column.startedAt"),
        render: (row: Recording) => formatDateTime(row.startedAt),
        sortValue: (row: Recording) => Number(new Date(row.startedAt)),
        size: 190,
        minSize: 150,
        maxSize: 280,
      },
    ],
    [formatDateTime, t],
  );

  return (
    <>
      <PageHeader
        title={t("meetingRecorder.title")}
        description={t("meetingRecorder.description")}
        action={
          <div className="flex gap-2">
            {can("meeting_recorder.settings.read") && (
              <Button
                variant="secondary"
                onClick={() => navigate("/app/meeting-recorder/settings")}
              >
                <Settings className="h-4 w-4" />
                {t("meetingRecorder.settings")}
              </Button>
            )}
            {can("meeting_recorder.recording.create") && (
              <Button onClick={() => navigate("/app/meeting-recorder/new")}>
                <Plus className="h-4 w-4" />
                {t("meetingRecorder.new")}
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <MetricCard
          label={t("meetingRecorder.metric.duration")}
          value={duration(overview.data?.durationMs ?? 0)}
        />
        <MetricCard
          label={t("meetingRecorder.metric.storage")}
          value={bytes(overview.data?.storageBytes ?? 0)}
          tone="info"
        />
        <MetricCard
          label={t("meetingRecorder.metric.transcribed")}
          value={overview.data?.transcriptionsReady ?? 0}
          tone="success"
        />
        <MetricCard
          label={t("meetingRecorder.metric.interrupted")}
          value={overview.data?.interrupted ?? 0}
          tone="warning"
        />
      </div>
      {session.recoverable.map((item) => (
        <div
          key={item.recordingId}
          className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm"
        >
          <RotateCcw className="h-4 w-4 text-amber-700" />
          <span className="flex-1">
            {t("meetingRecorder.recoveryFound", { name: item.title })}
          </span>
          <Button
            variant="secondary"
            onClick={() =>
              void session
                .recover(item)
                .then(() =>
                  toast.success(t("meetingRecorder.recoveryComplete")),
                )
                .catch((error: unknown) =>
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t("meetingRecorder.loadFailed"),
                  ),
                )
            }
          >
            {t("meetingRecorder.recover")}
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              confirm(t("meetingRecorder.discardConfirm")) &&
              void session.dismissRecovery(item.recordingId)
            }
          >
            {t("meetingRecorder.discard")}
          </Button>
        </div>
      ))}
      <SingleLineFilterBar className="mb-4">
        <Input
          value={search}
          onChange={(event) => {
            setCursor(null);
            setSearch(event.target.value);
          }}
          placeholder={t("meetingRecorder.search")}
          aria-label={t("meetingRecorder.search")}
        />
        <Select
          value={status}
          onChange={(event) => {
            setCursor(null);
            setStatus(event.target.value);
          }}
          aria-label={t("common.status")}
        >
          <option value="">{t("meetingRecorder.allStatuses")}</option>
          <option value="complete">
            {t("meetingRecorder.status.complete")}
          </option>
          <option value="recording">
            {t("meetingRecorder.status.recording")}
          </option>
          <option value="interrupted">
            {t("meetingRecorder.status.interrupted")}
          </option>
        </Select>
        <Select
          value={source}
          onChange={(event) => {
            setCursor(null);
            setSource(event.target.value);
          }}
          aria-label={t("meetingRecorder.column.source")}
        >
          <option value="">{t("meetingRecorder.allSources")}</option>
          <option value="live">{t("meetingRecorder.source.live")}</option>
          <option value="upload">{t("meetingRecorder.source.upload")}</option>
          <option value="telegram">
            {t("meetingRecorder.source.telegram")}
          </option>
        </Select>
      </SingleLineFilterBar>
      {recordings.isPending ? (
        <Skeleton className="h-72" />
      ) : (
        <ConfigurableDataTable
          tableId="plugin.meeting_recorder.recordings"
          rows={recordings.data?.items ?? []}
          columns={columns}
          sorting={sorting}
          onSortingChange={changeSorting}
          manualSorting
          onOpen={(row) => navigate(`/app/meeting-recorder/${row.id}`)}
          actions={(row) => (
            <Button
              variant="ghost"
              className="px-2"
              onClick={() => navigate(`/app/meeting-recorder/${row.id}`)}
              aria-label={t("meetingRecorder.open", { name: row.title })}
            >
              {row.ingestSource === "upload" ? (
                <Upload className="h-4 w-4" />
              ) : (
                <Mic className="h-4 w-4" />
              )}
            </Button>
          )}
        />
      )}
      {recordings.data?.nextCursor && (
        <div className="mt-4 flex justify-end">
          <Button
            variant="secondary"
            onClick={() => setCursor(recordings.data!.nextCursor)}
          >
            {t("meetingRecorder.nextPage")}
          </Button>
        </div>
      )}
    </>
  );
}

export default function MeetingRecorderHomePage() {
  return (
    <MeetingRecorderRouteGate>
      <HomeContent />
    </MeetingRecorderRouteGate>
  );
}
