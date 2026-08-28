import { useMutation, useQuery } from "@tanstack/react-query";
import { Mic, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  Select,
  ToggleSwitch,
} from "../../../frontend/src/components/ui/index.js";
import {
  hasTranslation,
  translate,
  useI18n,
} from "../../../frontend/src/i18n/index.js";
import { recorderApi, sha256Base64, uploadSegment } from "./api-client.js";
import { MeetingRecorderRouteGate } from "./MeetingRecorderRouteGate.js";
import { useMeetingRecorderSession } from "./MeetingRecorderSessionProvider.js";

const CONSENT_VERSION = "2026-08-28";
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const audioMime = (file: File): string => {
  const normalized = file.type.toLowerCase().split(";")[0] ?? "";
  if (
    [
      "audio/webm",
      "audio/ogg",
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/x-m4a",
      "audio/wav",
      "audio/x-wav",
    ].includes(normalized)
  )
    return normalized;
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const byExtension: Record<string, string> = {
    webm: "audio/webm",
    ogg: "audio/ogg",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    mp4: "audio/mp4",
    wav: "audio/wav",
  };
  if (extension && byExtension[extension]) return byExtension[extension];
  throw new Error("UNSUPPORTED_AUDIO_TYPE");
};
const localizedError = (error: Error): string => {
  const key = `meetingRecorder.error.${error.message}`;
  return hasTranslation(key) ? translate(key) : error.message;
};

const audioDuration = (file: File): Promise<number> =>
  new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const value = Math.round(audio.duration * 1_000);
      URL.revokeObjectURL(url);
      if (!Number.isFinite(value) || value < 1_000)
        reject(new Error("INVALID_AUDIO_DURATION"));
      else resolve(value);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("INVALID_AUDIO_FILE"));
    };
    audio.src = url;
  });

function NewContent() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const session = useMeetingRecorderSession();
  const [title, setTitle] = useState("");
  const [sourceMode, setSourceMode] = useState<"microphone" | "microphone_tab">(
    "microphone",
  );
  const [language, setLanguage] = useState<"pt-BR" | "en" | "auto">("pt-BR");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const defaults = useQuery({
    queryKey: ["meeting-recorder", "defaults"],
    queryFn: recorderApi.defaults,
  });
  useEffect(() => {
    if (!defaults.data) return;
    setLanguage(defaults.data.defaultLanguage);
    setAutoTranscribe(defaults.data.autoTranscribe);
  }, [defaults.data]);

  const begin = useMutation({
    mutationFn: () =>
      session.start({
        title: title.trim(),
        sourceMode,
        language,
        autoTranscribe,
      }),
    onSuccess: () => navigate("/app/meeting-recorder"),
    onError: (error: Error) => toast.error(localizedError(error)),
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("FILE_REQUIRED");
      if (file.size > MAX_IMPORT_BYTES) throw new Error("FILE_TOO_LARGE");
      const durationMs = await audioDuration(file);
      const mimeType = audioMime(file);
      const clientSessionId = crypto.randomUUID();
      const checksumSha256 = await sha256Base64(file);
      const created = await recorderApi.createImport({
        clientSessionId,
        title: title.trim() || file.name.replace(/\.[^.]+$/u, ""),
        fileName: file.name,
        mimeType,
        sizeBytes: file.size,
        durationMs,
        language,
        autoTranscribe,
        consentVersion: CONSENT_VERSION,
        consentAcknowledged: true,
      });
      await uploadSegment({
        recordingId: created.recording.id,
        sequence: created.uploadSequence,
        blob: file,
        mimeType,
        sizeBytes: file.size,
        startOffsetMs: 0,
        durationMs,
        checksumSha256,
        clientSessionId,
        attempts: 0,
        nextRetryAt: Date.now(),
      });
      if (autoTranscribe)
        await recorderApi.transcribe(created.recording.id, 0, checksumSha256);
      return created.recording.id;
    },
    onSuccess: (id) => {
      toast.success(t("meetingRecorder.uploadComplete"));
      navigate(`/app/meeting-recorder/${id}`);
    },
    onError: (error: Error) => toast.error(localizedError(error)),
  });

  return (
    <>
      <PageHeader
        title={t("meetingRecorder.new")}
        description={t("meetingRecorder.newDescription")}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="mb-5 flex items-center gap-3">
            <Mic className="h-6 w-6 text-indigo-600" />
            <div>
              <h2 className="font-bold">{t("meetingRecorder.liveTitle")}</h2>
              <p className="text-sm text-slate-500">
                {t("meetingRecorder.liveDescription")}
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="live-title">
                {t("meetingRecorder.column.title")}
              </Label>
              <Input
                id="live-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="source-mode">
                {t("meetingRecorder.captureSource")}
              </Label>
              <Select
                id="source-mode"
                value={sourceMode}
                onChange={(event) =>
                  setSourceMode(event.target.value as typeof sourceMode)
                }
              >
                <option value="microphone">
                  {t("meetingRecorder.microphone")}
                </option>
                <option value="microphone_tab">
                  {t("meetingRecorder.microphoneTab")}
                </option>
              </Select>
            </div>
            <div>
              <Label htmlFor="recording-language">{t("common.language")}</Label>
              <Select
                id="recording-language"
                value={language}
                onChange={(event) =>
                  setLanguage(event.target.value as typeof language)
                }
              >
                <option value="pt-BR">Português</option>
                <option value="en">English</option>
                <option value="auto">
                  {t("meetingRecorder.autoLanguage")}
                </option>
              </Select>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-xl border p-3 text-sm">
              <span>{t("meetingRecorder.autoTranscribe")}</span>
              <ToggleSwitch
                checked={autoTranscribe}
                onClick={() => setAutoTranscribe((value) => !value)}
                aria-label={t("meetingRecorder.autoTranscribe")}
              />
            </label>
            <p className="text-xs text-slate-500">
              {t("meetingRecorder.consent")}
            </p>
            <Button
              className="w-full"
              busy={begin.isPending}
              disabled={!title.trim() || session.state !== "idle"}
              onClick={() => begin.mutate()}
            >
              <Mic className="h-4 w-4" />
              {t("meetingRecorder.start")}
            </Button>
          </div>
        </Card>
        <Card>
          <div className="mb-5 flex items-center gap-3">
            <Upload className="h-6 w-6 text-indigo-600" />
            <div>
              <h2 className="font-bold">{t("meetingRecorder.uploadTitle")}</h2>
              <p className="text-sm text-slate-500">
                {t("meetingRecorder.uploadDescription")}
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <div>
              <Label htmlFor="audio-file">
                {t("meetingRecorder.audioFile")}
              </Label>
              <Input
                id="audio-file"
                type="file"
                accept="audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav,.m4a,.mp3,.ogg,.wav,.webm"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </div>
            <p className="text-xs text-slate-500">
              {t("meetingRecorder.uploadLimit")}
            </p>
            <Button
              className="w-full"
              busy={upload.isPending}
              disabled={!file}
              onClick={() => upload.mutate()}
            >
              <Upload className="h-4 w-4" />
              {t("meetingRecorder.uploadAndTranscribe")}
            </Button>
          </div>
        </Card>
      </div>
    </>
  );
}

export default function MeetingRecorderNewPage() {
  return (
    <MeetingRecorderRouteGate>
      <NewContent />
    </MeetingRecorderRouteGate>
  );
}
