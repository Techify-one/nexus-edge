import { CircleStop, Pause, Play, RefreshCw } from "lucide-react";
import { Button } from "../../../frontend/src/components/ui/index.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { useMeetingRecorderSession } from "./MeetingRecorderSessionProvider.js";

const clock = (milliseconds: number) => {
  const total = Math.floor(milliseconds / 1_000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

export function MiniRecorderBar() {
  const { t } = useI18n();
  const session = useMeetingRecorderSession();
  if (session.state === "idle") return null;
  return (
    <div
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-3xl items-center gap-3 rounded-2xl border border-indigo-200 bg-white p-3 shadow-2xl"
      role="status"
    >
      <span
        className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-red-500"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-slate-900">
          {session.recording?.title ?? t("meetingRecorder.starting")}
        </p>
        <p className="text-xs text-slate-500">
          {clock(session.elapsedMs)} ·{" "}
          {t("meetingRecorder.queue", {
            count: session.queue.pending + session.queue.uploading,
          })}
        </p>
      </div>
      {session.updatePending && (
        <Button
          variant="secondary"
          onClick={() => void session.stopAndReload()}
        >
          <RefreshCw className="h-4 w-4" />
          {t("meetingRecorder.stopAndUpdate")}
        </Button>
      )}
      {session.state === "recording" ? (
        <Button variant="secondary" onClick={() => void session.pause()}>
          <Pause className="h-4 w-4" />
          {t("meetingRecorder.pause")}
        </Button>
      ) : session.state === "paused" ? (
        <Button variant="secondary" onClick={() => void session.resume()}>
          <Play className="h-4 w-4" />
          {t("meetingRecorder.resume")}
        </Button>
      ) : null}
      <Button
        variant="danger"
        busy={session.state === "finalizing"}
        onClick={() => void session.stop()}
      >
        <CircleStop className="h-4 w-4" />
        {t("meetingRecorder.stop")}
      </Button>
    </div>
  );
}
