import {
  Award,
  Check,
  LockKeyhole,
  Mic,
  Play,
  RotateCcw,
  Send,
  Share2,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Button,
  Card,
  DataValue,
  MetricCard,
  Skeleton,
} from "../../../frontend/src/components/ui/index.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { publicApi } from "./client.js";
import type {
  AttemptFeedback,
  PracticeProfile,
  PracticeSummary,
} from "./types.js";

type Mode =
  "dashboard" | "resume" | "preparing" | "playing" | "feedback" | "finished";

const elapsedLabel = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
};

const chooseMimeType = (): string => {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/mp4",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
};

export default function PracticePage() {
  const { token = "" } = useParams();
  const { t } = useI18n();
  const [profile, setProfile] = useState<PracticeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [captureError, setCaptureError] = useState("");
  const [mode, setMode] = useState<Mode>("dashboard");
  const [sessionId, setSessionId] = useState("");
  const [phaseNumber, setPhaseNumber] = useState(1);
  const [words, setWords] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [feedback, setFeedback] = useState<AttemptFeedback | null>(null);
  const [summary, setSummary] = useState<PracticeSummary | null>(null);
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [listened, setListened] = useState(false);
  const [sending, setSending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [runningScore, setRunningScore] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const recordingStartedAtRef = useRef(0);
  const scoresRef = useRef<number[]>([]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const loadProfile = useCallback(async () => {
    try {
      setError("");
      const data = await publicApi<PracticeProfile>(`/play/${token}`);
      setProfile(data);
      if (data.activeSession) {
        setSessionId(data.activeSession.id);
        setPhaseNumber(data.activeSession.phase);
        setWords(data.activeSession.words);
        setPosition(data.activeSession.nextPosition);
        scoresRef.current = data.activeSession.scores;
        setRunningScore(data.activeSession.runningScore);
        setMode("resume");
      }
    } catch {
      setError(t("soletrando.practice.invalidLink"));
    } finally {
      setLoading(false);
    }
  }, [t, token]);

  useEffect(() => {
    void loadProfile();
    return () => {
      if (utteranceRef.current) {
        utteranceRef.current.onend = null;
        utteranceRef.current.onerror = null;
      }
      window.speechSynthesis?.cancel();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [loadProfile]);

  useEffect(() => {
    const manifest = document.createElement("link");
    manifest.rel = "manifest";
    manifest.href = `/api/v1/public/p/soletrando/pwa/manifest.webmanifest?start=${encodeURIComponent(window.location.pathname)}`;
    window.document.head.appendChild(manifest);
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker
        .register("/api/v1/public/p/soletrando/pwa/sw.js", {
          scope: "/soletrando/",
        })
        .catch(() => undefined);
    return () => {
      manifest.parentNode?.removeChild(manifest);
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const interval = window.setInterval(
      () => setElapsed(performance.now() - recordingStartedAtRef.current),
      100,
    );
    return () => window.clearInterval(interval);
  }, [recording]);

  const startRecorder = (stream: MediaStream) => {
    chunksRef.current = [];
    const mimeType = chooseMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined,
    );
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorderRef.current = recorder;
    recordingStartedAtRef.current = performance.now();
    setElapsed(0);
    setRecording(true);
    recorder.start(250);
  };

  const showPosition = (next: number, alreadyListened = false) => {
    setPosition(next);
    setFeedback(null);
    setCaptureError("");
    setRecording(false);
    setSpeaking(false);
    setListened(alreadyListened);
    setMode("playing");
  };

  const speakWord = (word = words[position] ?? "") => {
    if (recording || speaking || sending) return;
    setCaptureError("");
    if (!word || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      setCaptureError(t("soletrando.practice.speechUnsupported"));
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      word.toLocaleLowerCase("pt-BR"),
    );
    utterance.lang = "pt-BR";
    utterance.rate = 0.82;
    utterance.pitch = 1;
    const voice = window.speechSynthesis
      .getVoices()
      .find((candidate) => candidate.lang.toLowerCase() === "pt-br");
    if (voice) utterance.voice = voice;
    utterance.onerror = () => {
      utteranceRef.current = null;
      setSpeaking(false);
      setCaptureError(t("soletrando.practice.speechUnsupported"));
    };
    utterance.onend = () => {
      utteranceRef.current = null;
      setSpeaking(false);
      setListened(true);
    };
    utteranceRef.current = utterance;
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  };

  const startSpelling = async () => {
    if (!listened || recording || speaking || sending) return;
    setCaptureError("");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setCaptureError(t("soletrando.practice.microphoneUnsupported"));
      return;
    }
    try {
      let stream = streamRef.current;
      if (
        !stream ||
        stream.getTracks().every((track) => track.readyState === "ended")
      ) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        streamRef.current = stream;
      }
      if (!stream.getAudioTracks().some((track) => track.readyState === "live"))
        throw new Error("microphone stopped");
      stream.getAudioTracks().forEach((track) => (track.enabled = true));
      startRecorder(stream);
    } catch {
      setCaptureError(t("soletrando.practice.microphoneDenied"));
    }
  };

  const startPhase = async (phase: number) => {
    try {
      setError("");
      setMode("preparing");
      setSummary(null);
      const data = await publicApi<{
        session: {
          id: string;
          nextPosition?: number;
          scores?: number[];
          runningScore?: number;
        };
        phase: { words: string[] };
      }>(`/play/${token}/sessions`, {
        method: "POST",
        body: JSON.stringify({ phase }),
      });
      setSessionId(data.session.id);
      setPhaseNumber(phase);
      setWords(data.phase.words);
      scoresRef.current = data.session.scores ?? [];
      setRunningScore(data.session.runningScore ?? 0);
      const next = data.session.nextPosition ?? 0;
      if (next >= 10) setMode("resume");
      else showPosition(next);
    } catch {
      setError(t("soletrando.practice.tryAgain"));
      setMode("dashboard");
    }
  };

  const stopRecorder = (): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        reject(new Error("recording unavailable"));
        return;
      }
      recorder.onerror = () => reject(new Error("recording failed"));
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || "audio/webm",
        });
        streamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
        resolve(blob);
      };
      recorder.stop();
      setRecording(false);
    });

  const sendAttempt = async () => {
    if (sending || !recording) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    try {
      setSending(true);
      const attemptElapsed = performance.now() - recordingStartedAtRef.current;
      const audio = await stopRecorder();
      const form = new FormData();
      form.set("sessionId", sessionId);
      form.set("position", String(position));
      form.set("elapsedMs", String(Math.round(attemptElapsed)));
      form.set(
        "audio",
        audio,
        `soletracao.${audio.type.includes("mp4") ? "m4a" : "webm"}`,
      );
      const data = await publicApi<AttemptFeedback>(`/play/${token}/attempts`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      setFeedback(data);
      if (data.status === "evaluated") {
        scoresRef.current = [...scoresRef.current, data.attempt.totalScore];
        setRunningScore(
          Math.round(
            scoresRef.current.reduce((sum, score) => sum + score, 0) /
              scoresRef.current.length,
          ),
        );
      }
      setMode("feedback");
    } catch {
      setFeedback({
        status: "retry",
        reason: controller.signal.aborted
          ? t("soletrando.practice.transcriptionTimeout")
          : t("soletrando.practice.tryAgain"),
      });
      setMode("feedback");
    } finally {
      window.clearTimeout(timeout);
      setSending(false);
    }
  };

  const finishPhase = async () => {
    try {
      setMode("preparing");
      const data = await publicApi<{ summary: PracticeSummary }>(
        `/play/${token}/sessions/${sessionId}/finish`,
        { method: "POST" },
      );
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setSummary(data.summary);
      setMode("finished");
      await loadProfile();
      setMode("finished");
    } catch {
      setError(t("soletrando.practice.tryAgain"));
      setMode("feedback");
    }
  };

  const nextWord = async () => {
    if (position === 9) {
      await finishPhase();
      return;
    }
    const next = position + 1;
    showPosition(next);
  };

  const resume = async () => {
    const active = profile?.activeSession;
    if (!active) return;
    setSessionId(active.id);
    setPhaseNumber(active.phase);
    setWords(active.words);
    scoresRef.current = active.scores;
    setRunningScore(active.runningScore);
    if (active.nextPosition >= 10) await finishPhase();
    else showPosition(active.nextPosition);
  };

  const retry = () => showPosition(position, true);

  const share = async () => {
    const data = {
      title: t("soletrando.title"),
      text: t("soletrando.practice.welcome"),
      url: window.location.href,
    };
    if (navigator.share) await navigator.share(data);
    else await navigator.clipboard.writeText(window.location.href);
  };

  if (loading)
    return (
      <main className="app-shell grid min-h-[100dvh] place-items-center px-3 py-4 sm:p-6">
        <div className="w-full max-w-lg space-y-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-72" />
        </div>
      </main>
    );
  if (!profile)
    return (
      <main className="app-shell grid min-h-[100dvh] place-items-center px-3 py-4 sm:p-6">
        <Card className="w-full max-w-md p-5 text-center sm:p-6">
          <LockKeyhole className="mx-auto h-10 w-10 text-indigo-600" />
          <h1 className="mt-4 text-2xl font-bold">
            {t("soletrando.practice.invalidLink")}
          </h1>
          <Button
            className="mt-5 min-h-14 w-full text-base"
            onClick={() => void loadProfile()}
          >
            {t("soletrando.practice.tryAgain")}
          </Button>
        </Card>
      </main>
    );
  if (mode === "preparing")
    return (
      <main className="app-shell grid min-h-[100dvh] place-items-center px-3 py-4 sm:p-6">
        <Card className="w-full max-w-md p-5 text-center sm:p-6">
          <Sparkles className="mx-auto h-12 w-12 animate-pulse text-indigo-600" />
          <h1 className="mt-4 text-2xl font-bold">
            {t("soletrando.practice.loading")}
          </h1>
        </Card>
      </main>
    );
  if (mode === "resume" && profile.activeSession)
    return (
      <main className="app-shell grid min-h-[100dvh] place-items-center px-3 py-4 sm:p-6">
        <Card className="w-full max-w-lg p-5 text-center sm:p-6">
          <Volume2 className="mx-auto h-12 w-12 text-indigo-600" />
          <p className="mt-4 text-sm font-semibold text-indigo-600">
            {t("soletrando.phase")} {profile.activeSession.phase} ·{" "}
            {Math.min(profile.activeSession.nextPosition + 1, 10)}/10
          </p>
          <h1 className="mt-2 text-2xl font-bold sm:text-3xl">
            {t("soletrando.practice.resumeTitle")}
          </h1>
          <p className="mt-3 text-slate-500">
            {t("soletrando.practice.resumeDescription")}
          </p>
          <Button
            className="mt-6 min-h-14 w-full text-base"
            onClick={() => void resume()}
          >
            <Play className="h-5 w-5" />
            {profile.activeSession.nextPosition < 10
              ? t("soletrando.practice.resume")
              : t("soletrando.practice.showResult")}
          </Button>
          <Button
            className="mt-2 min-h-12 w-full"
            variant="ghost"
            onClick={() => setMode("dashboard")}
          >
            {t("soletrando.practice.viewPhases")}
          </Button>
        </Card>
      </main>
    );
  if (mode === "playing")
    return (
      <main className="app-shell min-h-[100dvh] px-3 py-4 sm:p-8">
        <div className="mx-auto flex min-h-[calc(100dvh-2rem)] max-w-2xl flex-col sm:min-h-[calc(100dvh-4rem)]">
          <div className="mb-4 flex items-center justify-between">
            <span className="text-sm font-semibold text-slate-500">
              {t("soletrando.phase")} {phaseNumber}
            </span>
            <DataValue tone="accent">{position + 1}/10</DataValue>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-indigo-600 transition-all"
              style={{ width: `${(position + 1) * 10}%` }}
            />
          </div>
          <Card className="my-4 flex flex-1 flex-col items-center justify-center p-4 text-center sm:my-6 sm:p-6">
            <p className="text-sm font-semibold uppercase tracking-wide text-indigo-600">
              {t("soletrando.practice.secretWord")}
            </p>
            <div className="mt-5 grid h-20 w-20 place-items-center rounded-full bg-indigo-50 text-indigo-600 sm:mt-6 sm:h-24 sm:w-24 dark:bg-indigo-950/40">
              {recording ? (
                <Mic className="h-10 w-10 animate-pulse sm:h-12 sm:w-12" />
              ) : sending ? (
                <Sparkles className="h-10 w-10 animate-spin sm:h-12 sm:w-12" />
              ) : (
                <Volume2 className="h-10 w-10 sm:h-12 sm:w-12" />
              )}
            </div>
            <h1 className="mt-5 text-2xl font-bold sm:mt-6 sm:text-3xl">
              {sending
                ? t("soletrando.practice.analyzing")
                : recording
                  ? t("soletrando.practice.yourTurn")
                  : speaking
                    ? t("soletrando.practice.listenCarefully")
                    : listened
                      ? t("soletrando.practice.readyToSpell")
                      : t("soletrando.practice.readyToListen")}
            </h1>
            <p className="mt-3 max-w-md text-slate-500">
              {recording
                ? t("soletrando.practice.spellThenSend")
                : sending
                  ? t("soletrando.practice.audioAfterSend")
                  : listened
                    ? t("soletrando.practice.listenedInstructions")
                    : t("soletrando.practice.listenInstructions")}
            </p>
            {recording && (
              <div className="mt-6 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                <span className="h-3 w-3 animate-pulse rounded-full bg-red-600" />
                <strong>{t("soletrando.practice.recording")}</strong>
                <span>{(elapsed / 1_000).toFixed(1)}s</span>
              </div>
            )}
            {recording && (
              <p className="mt-3 text-xs text-slate-500">
                {t("soletrando.practice.audioAfterSend")}
              </p>
            )}
            {captureError && (
              <p
                className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
                role="alert"
              >
                {captureError}
              </p>
            )}
          </Card>
          {recording || sending ? (
            <Button
              className="min-h-16 w-full shrink-0 text-base"
              disabled={sending}
              onClick={() => void sendAttempt()}
            >
              {sending ? (
                <Sparkles className="h-5 w-5 animate-spin" />
              ) : (
                <Send className="h-5 w-5" />
              )}
              {sending
                ? t("soletrando.practice.analyzing")
                : t("soletrando.practice.send")}
            </Button>
          ) : (
            <div className="grid shrink-0 gap-3 sm:grid-cols-2">
              <Button
                className="min-h-16 w-full border-indigo-200 bg-indigo-50 text-base text-indigo-700 hover:bg-indigo-100 dark:border-indigo-700 dark:text-indigo-200"
                variant="secondary"
                disabled={speaking}
                onClick={() => speakWord()}
              >
                <Volume2 className="h-5 w-5" />
                {speaking
                  ? t("soletrando.practice.speaking")
                  : listened
                    ? t("soletrando.practice.listenAgain")
                    : t("soletrando.practice.listen")}
              </Button>
              <Button
                className="min-h-16 w-full text-base"
                disabled={!listened || speaking}
                onClick={() => void startSpelling()}
              >
                <Mic className="h-5 w-5" />
                {t("soletrando.practice.spell")}
              </Button>
            </div>
          )}
          <p className="mt-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] text-center text-sm text-slate-500">
            {t("soletrando.practice.currentScore", { score: runningScore })}
          </p>
        </div>
      </main>
    );
  if (mode === "feedback" && feedback) {
    const retrying = feedback.status === "retry";
    const correct = feedback.status === "evaluated" && feedback.attempt.correct;
    const heard =
      feedback.status === "evaluated" ? feedback.attempt.heard : feedback.heard;
    const correctWord =
      feedback.status === "evaluated"
        ? feedback.attempt.correctWord
        : undefined;
    return (
      <main className="app-shell grid min-h-[100dvh] place-items-center px-3 py-4 sm:p-6">
        <Card className="w-full max-w-xl p-5 text-center sm:p-6">
          <div
            className={
              retrying
                ? "mx-auto grid h-20 w-20 place-items-center rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/40"
                : correct
                  ? "mx-auto grid h-20 w-20 place-items-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300"
                  : "mx-auto grid h-20 w-20 place-items-center rounded-full bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-300"
            }
          >
            {retrying ? (
              <RotateCcw className="h-10 w-10" />
            ) : correct ? (
              <ThumbsUp className="h-11 w-11" />
            ) : (
              <ThumbsDown className="h-11 w-11" />
            )}
          </div>
          <h1 className="mt-5 text-2xl font-bold sm:text-3xl">
            {retrying
              ? t("soletrando.practice.retryTitle")
              : correct
                ? t("soletrando.practice.correctTitle")
                : t("soletrando.practice.wrongTitle")}
          </h1>
          <p className="mt-3 text-slate-500">
            {retrying
              ? feedback.reason
              : correct
                ? t("soletrando.practice.correctDescription")
                : t("soletrando.practice.wrongDescription")}
          </p>
          {feedback.status === "evaluated" && heard && (
            <div
              className={`mt-5 grid gap-3 ${correct ? "" : "sm:grid-cols-2"}`}
            >
              {!correct && correctWord && (
                <Card className="border-emerald-200 bg-emerald-50 text-center dark:border-emerald-800">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                    {t("soletrando.practice.correctWord")}
                  </p>
                  <p className="mt-2 text-2xl font-black text-emerald-700 dark:text-emerald-300">
                    {correctWord}
                  </p>
                  <p className="mt-1 font-bold tracking-widest text-emerald-700 dark:text-emerald-300">
                    {correctWord.split("").join(" · ")}
                  </p>
                </Card>
              )}
              <Card
                className={
                  correct
                    ? "bg-slate-50 text-center"
                    : "border-red-200 bg-red-50 text-center dark:border-red-800"
                }
              >
                <p
                  className={`text-xs font-semibold uppercase tracking-wide ${correct ? "text-slate-500" : "text-red-700 dark:text-red-300"}`}
                >
                  {t(
                    correct
                      ? "soletrando.practice.understood"
                      : "soletrando.practice.yourSpelling",
                  )}
                </p>
                <p
                  className={`mt-2 text-xl font-bold tracking-widest ${correct ? "" : "text-red-700 dark:text-red-300"}`}
                >
                  {heard.split("").join(" · ")}
                </p>
              </Card>
            </div>
          )}
          {retrying && heard && (
            <Card className="mt-5 bg-slate-50 text-center">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {t("soletrando.practice.understood")}
              </p>
              <p className="mt-2 text-xl font-bold tracking-widest">
                {heard.split("").join(" · ")}
              </p>
            </Card>
          )}
          {feedback.status === "evaluated" && (
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <MetricCard
                label={t("soletrando.practice.accuracy")}
                value={feedback.attempt.accuracyScore}
                tone="info"
              />
              <MetricCard
                label={t("soletrando.practice.speed")}
                value={feedback.attempt.speedScore}
                tone="warning"
              />
              <MetricCard
                label={t("soletrando.practice.points")}
                value={feedback.attempt.totalScore}
                tone="success"
              />
            </div>
          )}
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
          <Button
            className="mt-6 min-h-14 w-full text-base"
            onClick={() => void (retrying ? retry() : nextWord())}
          >
            {retrying ? (
              <RotateCcw className="h-5 w-5" />
            ) : (
              <Play className="h-5 w-5" />
            )}
            {retrying
              ? t("soletrando.practice.recordAgain")
              : position === 9
                ? t("soletrando.practice.showResult")
                : t("soletrando.practice.nextWord")}
          </Button>
        </Card>
      </main>
    );
  }
  if (mode === "finished" && summary)
    return (
      <main className="app-shell grid min-h-[100dvh] place-items-center px-3 py-4 sm:p-6">
        <Card className="w-full max-w-xl p-5 text-center sm:p-6">
          {summary.passed ? (
            <Award className="mx-auto h-16 w-16 text-emerald-600" />
          ) : (
            <RotateCcw className="mx-auto h-16 w-16 text-red-600" />
          )}
          <p
            className={`mt-4 text-sm font-semibold uppercase tracking-wide ${summary.passed ? "text-emerald-600" : "text-red-600"}`}
          >
            {t(
              summary.passed
                ? "soletrando.practice.finished"
                : "soletrando.practice.notPassed",
              { phase: summary.phase },
            )}
          </p>
          <h1 className="mt-2 text-2xl font-bold sm:text-3xl">
            {t(
              summary.passed
                ? "soletrando.practice.finishedDescription"
                : "soletrando.practice.notPassedDescription",
            )}
          </h1>
          <p className="mt-5 text-5xl font-black text-indigo-600 sm:mt-6 sm:text-6xl">
            {summary.score}
          </p>
          <p className="text-sm text-slate-500">
            {t("soletrando.practice.outOf100")}
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <MetricCard
              label={t("soletrando.correctWords")}
              value={t("soletrando.practice.hits", {
                count: summary.correctCount,
              })}
              tone="success"
            />
            <MetricCard
              label={t("soletrando.practiceTime")}
              value={elapsedLabel(summary.totalTimeMs)}
              tone="info"
            />
          </div>
          {summary.passed ? (
            <>
              <Button
                className="mt-6 min-h-14 w-full text-base"
                onClick={() => setMode("dashboard")}
              >
                {t("soletrando.practice.viewPhases")}
              </Button>
              <Button
                className="mt-2 min-h-12 w-full"
                variant="ghost"
                onClick={() => void startPhase(summary.phase)}
              >
                {t("soletrando.practice.trainAgain")}
              </Button>
            </>
          ) : (
            <>
              <Button
                className="mt-6 min-h-14 w-full text-base"
                onClick={() => void startPhase(summary.phase)}
              >
                <RotateCcw className="h-5 w-5" />
                {t("soletrando.practice.tryPhaseAgain")}
              </Button>
              <Button
                className="mt-2 min-h-12 w-full"
                variant="ghost"
                onClick={() => setMode("dashboard")}
              >
                {t("soletrando.practice.viewPhases")}
              </Button>
            </>
          )}
        </Card>
      </main>
    );

  const correct = profile.totals.correctCount;
  const attempts = profile.totals.attemptsCount;
  return (
    <main className="app-shell min-h-[100dvh] px-3 py-4 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-indigo-600">
              {t("soletrando.practice.hello", { name: profile.child.name })}
            </p>
            <h1 className="text-2xl font-bold sm:text-3xl">
              {t("soletrando.practice.welcome")}
            </h1>
            <p className="mt-1 text-slate-500">
              {t("soletrando.practice.choosePhase")}
            </p>
          </div>
          <Button
            className="min-h-12 min-w-12 shrink-0 px-3"
            variant="secondary"
            onClick={() => void share()}
            aria-label={t("soletrando.practice.share")}
          >
            <Share2 className="h-5 w-5" />
          </Button>
        </div>
        <div className="mb-6 grid gap-3 min-[420px]:grid-cols-3 sm:gap-4">
          <MetricCard
            label={t("soletrando.completedPhases")}
            value={`${profile.phases.filter((phase) => phase.completed).length}/4`}
            tone="accent"
          />
          <MetricCard
            label={t("soletrando.correctWords")}
            value={correct}
            tone="success"
          />
          <MetricCard
            label={t("soletrando.accuracyRate")}
            value={`${attempts ? Math.round((correct / attempts) * 100) : 0}%`}
            tone="info"
          />
        </div>
        <div className="mb-4 flex items-end justify-between gap-3">
          <h2 className="text-xl font-bold">
            {t("soletrando.practice.journey")}
          </h2>
          <span className="text-sm text-slate-500">
            {t("soletrando.practice.wordsPerPhase")}
          </span>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {profile.phases.map((phase) => (
            <Card key={phase.id} className="flex flex-col p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <DataValue tone={phase.completed ? "success" : "accent"}>
                  {t("soletrando.phase")} {phase.id}
                </DataValue>
                {phase.completed ? (
                  <Check className="h-6 w-6 text-emerald-600" />
                ) : phase.unlocked ? (
                  <Sparkles className="h-6 w-6 text-indigo-600" />
                ) : (
                  <LockKeyhole className="h-6 w-6 text-slate-400" />
                )}
              </div>
              <h3 className="mt-4 text-xl font-bold">{phase.title}</h3>
              <p className="mt-2 flex-1 text-sm text-slate-500">
                {phase.completed
                  ? t("soletrando.practice.bestScore", {
                      score: phase.bestScore ?? 0,
                    })
                  : phase.unlocked
                    ? t("soletrando.practice.ready")
                    : t("soletrando.practice.completePrevious")}
              </p>
              <Button
                className="mt-5 min-h-14 w-full text-base"
                disabled={!phase.unlocked}
                onClick={() => void startPhase(phase.id)}
              >
                {phase.completed
                  ? t("soletrando.practice.trainAgain")
                  : phase.unlocked
                    ? t("soletrando.practice.start")
                    : t("soletrando.practice.locked")}
              </Button>
            </Card>
          ))}
        </div>
      </div>
    </main>
  );
}
