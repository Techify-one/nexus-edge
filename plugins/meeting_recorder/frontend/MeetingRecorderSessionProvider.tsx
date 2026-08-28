import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { registerReloadGuard } from "../../../frontend/src/lib/reload-guard.js";
import { translate } from "../../../frontend/src/i18n/index.js";
import { acquireCaptureMedia } from "./audio-mixer.js";
import { recorderApi, sha256Base64 } from "./api-client.js";
import { localRecorderStore, localStoragePreflight } from "./indexed-db.js";
import {
  IndependentMediaSegmenter,
  preferredRecorderMimeType,
} from "./media-recorder-segmenter.js";
import { MiniRecorderBar } from "./MiniRecorderBar.js";
import {
  SegmentUploadQueue,
  type UploadQueueSnapshot,
} from "./upload-queue.js";
import type {
  LocalSegment,
  LocalSession,
  RecorderSourceMode,
  Recording,
} from "./types.js";

const CONSENT_VERSION = "2026-08-28";
const SEGMENT_DURATION_MS = 10_000;

export type StartCaptureInput = {
  title: string;
  sourceMode: RecorderSourceMode;
  language: "pt-BR" | "en" | "auto";
  autoTranscribe: boolean;
};

type RecorderSessionContextValue = {
  recording: Recording | null;
  state: "idle" | "starting" | "recording" | "paused" | "finalizing";
  elapsedMs: number;
  queue: UploadQueueSnapshot;
  recoverable: LocalSession[];
  updatePending: boolean;
  start: (input: StartCaptureInput) => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  recover: (session: LocalSession) => Promise<void>;
  dismissRecovery: (recordingId: string) => Promise<void>;
  stopAndReload: () => Promise<void>;
};

const RecorderSessionContext =
  createContext<RecorderSessionContextValue | null>(null);

const emptyQueue: UploadQueueSnapshot = { pending: 0, uploading: 0, failed: 0 };

export function MeetingRecorderSessionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [state, setState] =
    useState<RecorderSessionContextValue["state"]>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [queueSnapshot, setQueueSnapshot] = useState(emptyQueue);
  const [recoverable, setRecoverable] = useState<LocalSession[]>([]);
  const [updatePending, setUpdatePending] = useState(false);
  const segmenter = useRef<IndependentMediaSegmenter | null>(null);
  const queue = useRef<SegmentUploadQueue | null>(null);
  const closeMedia = useRef<(() => void) | null>(null);
  const activeSession = useRef<LocalSession | null>(null);
  const uploaded = useRef<LocalSegment[]>([]);
  const autoTranscribe = useRef(true);

  useEffect(() => {
    void localRecorderStore
      .sessions()
      .then(setRecoverable)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(
      () => setElapsedMs((value) => value + 1_000),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => {
    if (!recording || (state !== "recording" && state !== "paused")) return;
    const heartbeat = () =>
      void recorderApi.heartbeat(recording.id).catch(() => undefined);
    heartbeat();
    const timer = window.setInterval(heartbeat, 30_000);
    return () => window.clearInterval(timer);
  }, [recording, state]);

  useEffect(
    () =>
      registerReloadGuard("meeting-recorder.capture", () => state !== "idle"),
    [state],
  );

  useEffect(() => {
    const update = () => setUpdatePending(true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (state === "idle") return;
      event.preventDefault();
    };
    window.addEventListener("app:update-pending", update);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("app:update-pending", update);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [state]);

  const persistSegment = useCallback(
    async (input: {
      blob: Blob;
      sequence: number;
      startOffsetMs: number;
      durationMs: number;
      mimeType: string;
    }) => {
      const session = activeSession.current;
      if (!session) return;
      const local: LocalSegment = {
        recordingId: session.recordingId,
        sequence: input.sequence,
        blob: input.blob,
        mimeType: input.mimeType,
        sizeBytes: input.blob.size,
        startOffsetMs: input.startOffsetMs,
        durationMs: input.durationMs,
        checksumSha256: await sha256Base64(input.blob),
        clientSessionId: session.clientSessionId,
        attempts: 0,
        nextRetryAt: Date.now(),
      };
      await localRecorderStore.saveSegment(local);
      const updatedSession = { ...session, nextSequence: input.sequence + 1 };
      activeSession.current = updatedSession;
      await localRecorderStore.saveSession(updatedSession);
      queue.current?.enqueue(local);
    },
    [],
  );

  const start = useCallback(
    async (input: StartCaptureInput) => {
      if (state !== "idle") throw new Error("CAPTURE_ALREADY_ACTIVE");
      setState("starting");
      try {
        const preflight = await localStoragePreflight();
        if (
          preflight.availableBytes !== null &&
          preflight.availableBytes < 50 * 1024 * 1024
        )
          throw new Error("LOCAL_STORAGE_LOW");
        const mimeType = preferredRecorderMimeType();
        if (!mimeType) throw new Error("MEDIA_RECORDER_UNSUPPORTED");
        const media = await acquireCaptureMedia(input.sourceMode);
        closeMedia.current = media.close;
        const clientSessionId = crypto.randomUUID();
        const created = await recorderApi.create({
          clientSessionId,
          title: input.title,
          sourceType: input.sourceMode,
          language: input.language,
          mimeType,
          bitrateBps: 64_000,
          segmentDurationMs: SEGMENT_DURATION_MS,
          autoTranscribe: input.autoTranscribe,
          consentVersion: CONSENT_VERSION,
          consentAcknowledged: true,
        });
        const session: LocalSession = {
          recordingId: created.recording.id,
          clientSessionId,
          title: input.title,
          sourceMode: input.sourceMode,
          nextSequence: 0,
          startedAt: Date.now(),
          accumulatedMs: 0,
          state: "recording",
        };
        await localRecorderStore.saveSession(session);
        activeSession.current = session;
        autoTranscribe.current = input.autoTranscribe;
        uploaded.current = [];
        queue.current = new SegmentUploadQueue(
          setQueueSnapshot,
          2,
          (segment) => {
            uploaded.current.push(segment);
          },
        );
        segmenter.current = new IndependentMediaSegmenter(
          media.stream,
          SEGMENT_DURATION_MS,
          0,
          persistSegment,
        );
        setRecording(created.recording);
        setElapsedMs(0);
        setState("recording");
        segmenter.current.start();
      } catch (error) {
        closeMedia.current?.();
        closeMedia.current = null;
        setState("idle");
        throw error;
      }
    },
    [persistSegment, state],
  );

  const pause = useCallback(async () => {
    if (!recording || state !== "recording") return;
    await segmenter.current?.pause();
    await recorderApi.captureState(recording.id, "paused");
    if (activeSession.current) {
      activeSession.current = { ...activeSession.current, state: "paused" };
      await localRecorderStore.saveSession(activeSession.current);
    }
    setState("paused");
  }, [recording, state]);

  const resume = useCallback(async () => {
    if (!recording || state !== "paused") return;
    await recorderApi.captureState(recording.id, "recording");
    if (activeSession.current) {
      activeSession.current = { ...activeSession.current, state: "recording" };
      await localRecorderStore.saveSession(activeSession.current);
    }
    setState("recording");
    segmenter.current?.resume();
  }, [recording, state]);

  const stop = useCallback(async () => {
    if (!recording || state === "idle" || state === "finalizing") return;
    setState("finalizing");
    await segmenter.current?.stop();
    closeMedia.current?.();
    closeMedia.current = null;
    await queue.current?.drain();
    if (queue.current?.hasFailures()) {
      await recorderApi.captureState(recording.id, "interrupted");
      const localSession = activeSession.current;
      if (localSession) {
        const interrupted: LocalSession = {
          ...localSession,
          state: "interrupted",
        };
        await localRecorderStore.saveSession(interrupted);
        setRecoverable((items) => [
          interrupted,
          ...items.filter(
            (item) => item.recordingId !== interrupted.recordingId,
          ),
        ]);
      }
      activeSession.current = null;
      segmenter.current = null;
      queue.current = null;
      setRecording(null);
      setState("idle");
      toast.error(translate("meetingRecorder.recoveryPendingError"));
      return;
    }
    await recorderApi.captureState(recording.id, "finalizing");
    const lastSequence = Math.max(
      0,
      (activeSession.current?.nextSequence ?? 1) - 1,
    );
    await recorderApi.finalize(recording.id, lastSequence);
    if (autoTranscribe.current) {
      for (const segment of uploaded.current.toSorted(
        (a, b) => a.sequence - b.sequence,
      )) {
        try {
          await recorderApi.transcribe(
            recording.id,
            segment.sequence,
            segment.checksumSha256,
          );
        } catch (error) {
          toast.error(
            error instanceof Error
              ? error.message
              : translate("meetingRecorder.transcriptionFailed"),
          );
          break;
        }
      }
    }
    await localRecorderStore.removeSession(recording.id);
    activeSession.current = null;
    segmenter.current = null;
    queue.current = null;
    setQueueSnapshot(emptyQueue);
    setRecoverable((items) =>
      items.filter((item) => item.recordingId !== recording.id),
    );
    setRecording(null);
    setState("idle");
  }, [recording, state]);

  const recover = useCallback(async (session: LocalSession) => {
    const segments = await localRecorderStore.segments(session.recordingId);
    const recoveryQueue = new SegmentUploadQueue(setQueueSnapshot);
    segments.forEach((segment) => recoveryQueue.enqueue(segment));
    await recoveryQueue.drain();
    if (recoveryQueue.hasFailures())
      throw new Error(translate("meetingRecorder.recoveryPendingError"));
    await recorderApi.finalize(
      session.recordingId,
      Math.max(0, session.nextSequence - 1),
    );
    await localRecorderStore.removeSession(session.recordingId);
    setRecoverable((items) =>
      items.filter((item) => item.recordingId !== session.recordingId),
    );
    setQueueSnapshot(emptyQueue);
  }, []);

  const dismissRecovery = useCallback(async (recordingId: string) => {
    const segments = await localRecorderStore.segments(recordingId);
    await Promise.all(
      segments.map((segment) =>
        localRecorderStore.removeSegment(recordingId, segment.sequence),
      ),
    );
    await localRecorderStore.removeSession(recordingId);
    setRecoverable((items) =>
      items.filter((item) => item.recordingId !== recordingId),
    );
  }, []);

  const stopAndReload = useCallback(async () => {
    await stop();
    window.location.reload();
  }, [stop]);

  useEffect(() => {
    const safeReload = () => void stopAndReload();
    window.addEventListener("app:request-safe-reload", safeReload);
    return () =>
      window.removeEventListener("app:request-safe-reload", safeReload);
  }, [stopAndReload]);

  const value = useMemo<RecorderSessionContextValue>(
    () => ({
      recording,
      state,
      elapsedMs,
      queue: queueSnapshot,
      recoverable,
      updatePending,
      start,
      pause,
      resume,
      stop,
      recover,
      dismissRecovery,
      stopAndReload,
    }),
    [
      dismissRecovery,
      elapsedMs,
      pause,
      queueSnapshot,
      recording,
      recover,
      recoverable,
      resume,
      start,
      state,
      stop,
      stopAndReload,
      updatePending,
    ],
  );

  return (
    <RecorderSessionContext.Provider value={value}>
      {children}
      <MiniRecorderBar />
    </RecorderSessionContext.Provider>
  );
}

export function useMeetingRecorderSession(): RecorderSessionContextValue {
  const context = useContext(RecorderSessionContext);
  if (!context)
    throw new Error(
      "useMeetingRecorderSession requires MeetingRecorderSessionProvider",
    );
  return context;
}
