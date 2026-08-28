import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Pencil, Play, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Skeleton,
} from "../../../frontend/src/components/ui/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import { recentReauthHeaders } from "../../../frontend/src/lib/api/core-client.js";
import { getAppLocale } from "../../../frontend/src/i18n/index.js";
import {
  useI18n,
  type TranslationKey,
} from "../../../frontend/src/i18n/index.js";
import { recorderApi, segmentAudioUrl } from "./api-client.js";
import { MeetingRecorderRouteGate } from "./MeetingRecorderRouteGate.js";

const statusKeys: Record<string, TranslationKey> = {
  recording: "meetingRecorder.status.recording",
  paused: "meetingRecorder.status.paused",
  interrupted: "meetingRecorder.status.interrupted",
  finalizing: "meetingRecorder.status.finalizing",
  complete: "meetingRecorder.status.complete",
  deleting: "meetingRecorder.status.deleting",
};

function DetailContent() {
  const { recordingId = "" } = useParams();
  const { t, formatDateTime } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [playlistIndex, setPlaylistIndex] = useState(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const recording = useQuery({
    queryKey: ["meeting-recorder", "recording", recordingId],
    queryFn: () => recorderApi.recording(recordingId),
  });
  const segments = useQuery({
    queryKey: ["meeting-recorder", "segments", recordingId],
    queryFn: () => recorderApi.segments(recordingId),
  });
  const transcript = useQuery({
    queryKey: ["meeting-recorder", "transcript", recordingId],
    queryFn: () => recorderApi.transcript(recordingId),
  });
  const [title, setTitle] = useState("");
  useEffect(
    () => setTitle(recording.data?.recording.title ?? ""),
    [recording.data],
  );

  const rename = useMutation({
    mutationFn: () =>
      recorderApi.rename(
        recordingId,
        title.trim(),
        recording.data!.recording.version,
      ),
    onSuccess: () => {
      setEditingTitle(false);
      void queryClient.invalidateQueries({ queryKey: ["meeting-recorder"] });
      toast.success(t("meetingRecorder.saved"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const transcribe = useMutation({
    mutationFn: async () => {
      for (const segment of segments.data?.items ?? []) {
        if (
          segment.storageStatus === "stored" &&
          segment.transcriptionStatus !== "ready"
        )
          await recorderApi.transcribe(
            recordingId,
            segment.sequence,
            segment.checksumSha256,
          );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["meeting-recorder", "recording", recordingId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-recorder", "segments", recordingId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-recorder", "transcript", recordingId],
      });
      toast.success(t("meetingRecorder.transcriptionComplete"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async () => {
      const headers = await recentReauthHeaders(
        t("meetingRecorder.deletePassword"),
      );
      const started = await recorderApi.deleteRecording(recordingId, headers);
      if (!started) return;
      let complete = false;
      let stepNumber = 0;
      while (!complete) {
        const step = await recorderApi.deletionStep(
          recordingId,
          started.operationId,
          stepNumber,
        );
        stepNumber += 1;
        complete = step?.complete ?? true;
      }
    },
    onSuccess: () => {
      toast.success(t("meetingRecorder.deleted"));
      navigate("/app/meeting-recorder", { replace: true });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (recording.isPending || segments.isPending || transcript.isPending)
    return <Skeleton className="h-96" />;
  if (!recording.data) return null;
  const item = recording.data.recording;
  const audioSegments =
    segments.data?.items.filter(
      (segment) => segment.storageStatus === "stored",
    ) ?? [];
  const activeAudio = audioSegments[playlistIndex];
  const downloadTranscript = async () => {
    const response = await fetch(
      `/api/v1/p/meeting_recorder/recordings/${encodeURIComponent(recordingId)}/transcript`,
      {
        credentials: "include",
        headers: {
          Accept: "text/plain",
          "Accept-Language": getAppLocale(),
        },
      },
    );
    if (!response.ok) throw new Error(t("meetingRecorder.loadFailed"));
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${item.title}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title={item.title}
        description={`${t(`meetingRecorder.source.${item.ingestSource}`)} · ${formatDateTime(item.startedAt)}`}
        action={
          <Badge
            tone={item.captureStatus === "complete" ? "success" : "warning"}
          >
            {t(
              statusKeys[item.effectiveCaptureStatus] ??
                "meetingRecorder.status.interrupted",
            )}
          </Badge>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <div className="space-y-5">
          <Card>
            <h2 className="font-bold">{t("meetingRecorder.audio")}</h2>
            {activeAudio ? (
              <>
                <audio
                  className="mt-4 w-full"
                  controls
                  src={segmentAudioUrl(recordingId, activeAudio.sequence)}
                  onEnded={() =>
                    setPlaylistIndex((index) =>
                      Math.min(index + 1, audioSegments.length - 1),
                    )
                  }
                />
                <p className="mt-2 text-xs text-slate-500">
                  {t("meetingRecorder.segmentProgress", {
                    current: playlistIndex + 1,
                    total: audioSegments.length,
                  })}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {audioSegments.map((segment, index) => (
                    <Button
                      key={segment.id}
                      variant={
                        index === playlistIndex ? "primary" : "secondary"
                      }
                      className="px-3"
                      onClick={() => setPlaylistIndex(index)}
                      aria-label={t("meetingRecorder.playSegment", {
                        number: segment.sequence + 1,
                      })}
                    >
                      <Play className="h-3.5 w-3.5" />
                      {segment.sequence + 1}
                    </Button>
                  ))}
                </div>
              </>
            ) : (
              <p className="mt-3 text-sm text-slate-500">
                {t("meetingRecorder.noAudio")}
              </p>
            )}
          </Card>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-bold">{t("meetingRecorder.transcript")}</h2>
              <div className="flex gap-2">
                {can("meeting_recorder.transcription.create") && (
                  <Button
                    variant="secondary"
                    busy={transcribe.isPending}
                    onClick={() => transcribe.mutate()}
                  >
                    {t("meetingRecorder.transcribe")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  onClick={() => void downloadTranscript()}
                >
                  <Download className="h-4 w-4" />
                  {t("meetingRecorder.download")}
                </Button>
              </div>
            </div>
            <div className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              {transcript.data?.text || t("meetingRecorder.noTranscript")}
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <Card>
            <h2 className="font-bold">{t("meetingRecorder.details")}</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">
                  {t("meetingRecorder.column.duration")}
                </dt>
                <dd>{Math.round(item.storedDurationMs / 1000)}s</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">
                  {t("meetingRecorder.column.size")}
                </dt>
                <dd>{(item.totalBytes / 1024 / 1024).toFixed(1)} MB</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">
                  {t("meetingRecorder.column.owner")}
                </dt>
                <dd>{item.ownerName ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">
                  {t("meetingRecorder.segments")}
                </dt>
                <dd>{item.storedSegmentCount}</dd>
              </div>
            </dl>
          </Card>
          {can("meeting_recorder.recording.update") && (
            <Card>
              <h2 className="font-bold">{t("meetingRecorder.rename")}</h2>
              {editingTitle ? (
                <div className="mt-3 flex gap-2">
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <Button
                    busy={rename.isPending}
                    disabled={!title.trim()}
                    onClick={() => rename.mutate()}
                  >
                    {t("common.save")}
                  </Button>
                </div>
              ) : (
                <Button
                  className="mt-3"
                  variant="secondary"
                  onClick={() => setEditingTitle(true)}
                >
                  <Pencil className="h-4 w-4" />
                  {t("common.edit")}
                </Button>
              )}
            </Card>
          )}
          {can("meeting_recorder.recording.delete") && (
            <Card className="border-red-200">
              <h2 className="font-bold text-red-700">
                {t("meetingRecorder.dangerZone")}
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                {t("meetingRecorder.deleteDescription")}
              </p>
              <Button
                className="mt-4"
                variant="danger"
                busy={remove.isPending}
                onClick={() =>
                  confirm(
                    t("meetingRecorder.deleteConfirm", { name: item.title }),
                  ) && remove.mutate()
                }
              >
                <Trash2 className="h-4 w-4" />
                {t("common.delete")}
              </Button>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

export default function MeetingRecorderDetailPage() {
  return (
    <MeetingRecorderRouteGate>
      <DetailContent />
    </MeetingRecorderRouteGate>
  );
}
