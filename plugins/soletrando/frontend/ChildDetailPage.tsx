import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ConfigurableDataTable } from "../../../frontend/src/components/ui/configurable-data-table.js";
import {
  Badge,
  Button,
  Card,
  DataValue,
  MetricCard,
  PageHeader,
  Skeleton,
} from "../../../frontend/src/components/ui/index.js";
import { api } from "../../../frontend/src/lib/api/core-client.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import type { AttemptRecord, ChildDetail, SessionRecord } from "./types.js";

const duration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}min ${seconds % 60}s`;
};

const statusTone = (
  status: SessionRecord["status"],
): "neutral" | "success" | "warning" =>
  status === "completed"
    ? "success"
    : status === "active"
      ? "warning"
      : "neutral";

export default function ChildDetailPage() {
  const { childId = "" } = useParams();
  const navigate = useNavigate();
  const { t, formatDateTime } = useI18n();
  const detail = useQuery({
    queryKey: ["soletrando", "children", childId],
    queryFn: () => api<ChildDetail>(`/api/v1/p/soletrando/children/${childId}`),
    enabled: Boolean(childId),
  });
  if (detail.isPending)
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-72" />
      </div>
    );
  if (detail.isError || !detail.data) throw detail.error;
  const data = detail.data;
  const completedPhases = new Set(
    data.sessions
      .filter((session) => session.status === "completed")
      .map((session) => session.phase),
  ).size;
  const accuracy = data.totals.attemptsCount
    ? Math.round((data.totals.correctCount / data.totals.attemptsCount) * 100)
    : 0;
  const copy = async () => {
    await navigator.clipboard.writeText(
      `${window.location.origin}/soletrando/c/${data.child.token}`,
    );
    toast.success(t("soletrando.linkCopied"));
  };
  const sessionStatus = (session: SessionRecord) =>
    t(
      session.status === "completed"
        ? "soletrando.completed"
        : session.status === "active"
          ? "soletrando.active"
          : "soletrando.abandoned",
    );

  return (
    <>
      <PageHeader
        title={data.child.name}
        description={t("soletrando.registeredAt", {
          date: formatDateTime(data.child.createdAt),
        })}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              onClick={() => navigate("/app/soletrando")}
            >
              <ArrowLeft className="h-4 w-4" />
              {t("soletrando.backToChildren")}
            </Button>
            <Button onClick={() => void copy()}>
              <Copy className="h-4 w-4" />
              {t("soletrando.copyLink")}
            </Button>
          </div>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t("soletrando.completedPhases")}
          value={`${completedPhases}/4`}
          tone="accent"
        />
        <MetricCard
          label={t("soletrando.correctWords")}
          value={data.totals.correctCount}
          tone="success"
        />
        <MetricCard
          label={t("soletrando.accuracyRate")}
          value={`${accuracy}%`}
          tone="info"
        />
        <MetricCard
          label={t("soletrando.practiceTime")}
          value={duration(data.totals.totalTimeMs)}
          tone="warning"
        />
      </div>
      <Card className="mb-6 p-0">
        <div className="p-5 pb-3">
          <h2 className="text-lg font-semibold">
            {t("soletrando.trainingSessions")}
          </h2>
        </div>
        <ConfigurableDataTable<SessionRecord>
          tableId="plugin.soletrando.sessions"
          rows={data.sessions}
          onOpen={() => undefined}
          emptyTitle={t("soletrando.noSessions")}
          columns={[
            {
              key: "phase",
              label: t("soletrando.phase"),
              render: (session) => session.phase,
              sortValue: (session) => session.phase,
              size: 120,
              minSize: 96,
              maxSize: 200,
            },
            {
              key: "status",
              label: t("common.status"),
              render: (session) => (
                <Badge tone={statusTone(session.status)}>
                  {sessionStatus(session)}
                </Badge>
              ),
              sortValue: (session) => session.status,
              size: 160,
              minSize: 120,
              maxSize: 260,
            },
            {
              key: "score",
              label: t("soletrando.score"),
              render: (session) =>
                session.score == null ? (
                  "—"
                ) : (
                  <DataValue tone="success">{session.score}</DataValue>
                ),
              sortValue: (session) => session.score ?? -1,
              size: 140,
              minSize: 110,
              maxSize: 220,
            },
            {
              key: "correct_count",
              label: t("soletrando.correctWords"),
              render: (session) => `${session.correctCount}/10`,
              sortValue: (session) => session.correctCount,
              size: 180,
              minSize: 120,
              maxSize: 280,
            },
            {
              key: "time",
              label: t("soletrando.time"),
              render: (session) => duration(session.totalTimeMs),
              sortValue: (session) => session.totalTimeMs,
              size: 160,
              minSize: 120,
              maxSize: 260,
            },
            {
              key: "date",
              label: t("common.date"),
              render: (session) =>
                formatDateTime(session.completedAt ?? session.startedAt),
              sortValue: (session) =>
                new Date(session.completedAt ?? session.startedAt).getTime(),
              size: 220,
              minSize: 160,
              maxSize: 360,
            },
          ]}
        />
      </Card>
      <Card className="p-0">
        <div className="p-5 pb-3">
          <h2 className="text-lg font-semibold">
            {t("soletrando.wordAttempts")}
          </h2>
        </div>
        <ConfigurableDataTable<AttemptRecord>
          tableId="plugin.soletrando.attempts"
          rows={data.attempts}
          onOpen={() => undefined}
          emptyTitle={t("soletrando.noAttempts")}
          columns={[
            {
              key: "word",
              label: t("soletrando.practice.secretWord"),
              render: (attempt) => (
                <span className="font-medium">{attempt.word}</span>
              ),
              sortValue: (attempt) => attempt.word,
              size: 200,
              minSize: 140,
              maxSize: 360,
            },
            {
              key: "heard",
              label: t("soletrando.heard"),
              render: (attempt) => attempt.normalized.split("").join(" · "),
              sortValue: (attempt) => attempt.normalized,
              size: 240,
              minSize: 160,
              maxSize: 420,
            },
            {
              key: "phase",
              label: t("soletrando.phase"),
              render: (attempt) => attempt.phase,
              sortValue: (attempt) => attempt.phase,
              size: 120,
              minSize: 96,
              maxSize: 200,
            },
            {
              key: "result",
              label: t("soletrando.result"),
              render: (attempt) => (
                <Badge tone={attempt.isCorrect ? "success" : "danger"}>
                  {t(
                    attempt.isCorrect
                      ? "soletrando.correct"
                      : "soletrando.wrong",
                  )}
                </Badge>
              ),
              sortValue: (attempt) => (attempt.isCorrect ? 1 : 0),
              size: 150,
              minSize: 110,
              maxSize: 240,
            },
            {
              key: "score",
              label: t("soletrando.score"),
              render: (attempt) => (
                <DataValue tone="accent">{attempt.totalScore}</DataValue>
              ),
              sortValue: (attempt) => attempt.totalScore,
              size: 140,
              minSize: 110,
              maxSize: 220,
            },
            {
              key: "time",
              label: t("soletrando.time"),
              render: (attempt) => duration(attempt.elapsedMs),
              sortValue: (attempt) => attempt.elapsedMs,
              size: 140,
              minSize: 110,
              maxSize: 220,
            },
            {
              key: "date",
              label: t("common.date"),
              render: (attempt) => formatDateTime(attempt.createdAt),
              sortValue: (attempt) => new Date(attempt.createdAt).getTime(),
              size: 220,
              minSize: 160,
              maxSize: 360,
            },
          ]}
        />
      </Card>
    </>
  );
}
