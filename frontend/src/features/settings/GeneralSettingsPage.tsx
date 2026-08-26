import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
  Badge,
  Button,
  Card,
  PageHeader,
  Skeleton,
} from "../../components/ui/index.js";
import { can } from "../../lib/ability.js";
import { api, recentReauthHeaders } from "../../lib/api/core-client.js";
import { useI18n, type TranslationKey } from "../../i18n/index.js";

type Operation = {
  operationId: string;
  targetVersion: string;
  state: "migrating" | "deploying" | "verifying" | "installed" | "failed";
  restoreTimestamp: string | number | null;
  failureCode?: string;
};

type GeneralSettings = {
  channel: "beta";
  currentVersion: string;
  provider: "d1" | "postgres";
  supported: boolean;
  credentialConfigured: boolean;
  updateAvailable: boolean;
  sourceError?: "unavailable";
  latest: null | {
    releaseId: string;
    version: string;
    tag: string;
    name: string;
    notes: string;
    pageUrl: string;
    publishedAt: string | null;
  };
  activeOperation: Operation | null;
};

const terminal = new Set(["installed", "failed"]);
const stageKeys: Record<Operation["state"], TranslationKey> = {
  migrating: "settings.updateStageMigrating",
  deploying: "settings.updateStageDeploying",
  verifying: "settings.updateStageVerifying",
  installed: "settings.updateStageInstalled",
  failed: "settings.updateStageFailed",
};

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export default function GeneralSettingsPage() {
  const { t, formatDateTime } = useI18n();
  const client = useQueryClient();
  const mayUpdate = can("core.settings.update");
  const status = useQuery({
    queryKey: ["settings", "general"],
    queryFn: () => api<GeneralSettings>("/api/v1/settings/general"),
    staleTime: 60_000,
  });

  const update = useMutation({
    mutationFn: async () => {
      const headers = await recentReauthHeaders(
        t("settings.confirmUpdatePassword"),
      );
      let operation = status.data?.activeOperation;
      if (!operation)
        operation = await api<Operation>(
          "/api/v1/settings/core-update-operations",
          {
            method: "POST",
            headers,
          },
        );
      while (!terminal.has(operation.state)) {
        if (operation.state === "verifying") await wait(4_000);
        try {
          operation = await api<Operation>(
            `/api/v1/settings/core-update-operations/${operation.operationId}/advance`,
            { method: "POST", headers },
          );
        } catch (error) {
          if (operation.state !== "verifying") throw error;
          await wait(4_000);
          operation = await api<Operation>(
            `/api/v1/settings/core-update-operations/${operation.operationId}`,
          );
        }
      }
      if (operation.state === "failed")
        throw new Error(t("settings.updateFailed"));
      return operation;
    },
    onSuccess: async () => {
      toast.success(t("settings.updateInstalled"));
      await client.invalidateQueries({ queryKey: ["settings", "general"] });
      window.setTimeout(() => window.location.reload(), 1_000);
    },
    onError: (error: Error) => {
      toast.error(error.message);
      void client.invalidateQueries({ queryKey: ["settings", "general"] });
    },
  });

  if (status.isPending) return <Skeleton className="h-96" />;
  if (status.isError)
    return (
      <Card className="border-red-200 bg-red-50 text-red-800">
        {status.error.message}
      </Card>
    );
  const data = status.data!;
  const operation = data.activeOperation;
  const buttonDisabled =
    !mayUpdate ||
    !data.supported ||
    !data.credentialConfigured ||
    (!data.updateAvailable && !operation) ||
    Boolean(data.sourceError && operation?.state !== "verifying");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("settings.title")}
        description={t("settings.description")}
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-indigo-50 text-indigo-700">
              <Settings className="h-5 w-5" aria-hidden />
            </span>
            <div>
              <h2 className="font-bold text-slate-900">
                {t("settings.installationTitle")}
              </h2>
              <p className="text-sm text-slate-500">
                {t("settings.installationDescription")}
              </p>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">{t("common.version")}</dt>
              <dd className="mt-1 font-semibold">{data.currentVersion}</dd>
            </div>
            <div>
              <dt className="text-slate-500">{t("settings.provider")}</dt>
              <dd className="mt-1 font-semibold uppercase">{data.provider}</dd>
            </div>
            <div>
              <dt className="text-slate-500">{t("settings.channel")}</dt>
              <dd className="mt-1">
                <Badge tone="warning">Beta</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">{t("settings.signature")}</dt>
              <dd className="mt-1 inline-flex items-center gap-1 font-semibold text-emerald-700">
                <ShieldCheck className="h-4 w-4" aria-hidden />{" "}
                {t("settings.required")}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-bold text-slate-900">
                  {t("settings.updatesTitle")}
                </h2>
                <Badge tone="warning">Beta</Badge>
              </div>
              <p className="mt-1 text-sm text-slate-500">
                {t("settings.updatesDescription")}
              </p>
            </div>
            <Button
              busy={update.isPending}
              disabled={buttonDisabled}
              onClick={() => update.mutate()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              {operation
                ? t("settings.continueUpdate")
                : t("settings.updateNow")}
            </Button>
          </div>

          {data.sourceError ? (
            <p className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {t("settings.sourceUnavailable")}
            </p>
          ) : data.latest ? (
            <div className="mt-5 rounded-xl border bg-slate-50 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold text-slate-900">
                    {data.latest.name}
                  </p>
                  <p className="text-sm text-slate-500">
                    {data.latest.version}
                    {data.latest.publishedAt
                      ? ` · ${formatDateTime(data.latest.publishedAt)}`
                      : ""}
                  </p>
                </div>
                <a
                  href={data.latest.pageUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-sm font-semibold text-indigo-700 underline underline-offset-2"
                >
                  {t("settings.releaseDetails")}{" "}
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
              {data.latest.notes && (
                <p className="mt-3 whitespace-pre-line text-sm text-slate-700">
                  {data.latest.notes}
                </p>
              )}
            </div>
          ) : (
            <p className="mt-5 inline-flex items-center gap-2 text-sm text-emerald-700">
              <CheckCircle2 className="h-4 w-4" /> {t("settings.noRelease")}
            </p>
          )}

          {!data.supported && (
            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {t("settings.d1Only")}
            </p>
          )}
          {!data.credentialConfigured && (
            <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {t("settings.credentialRequired")}{" "}
              <a className="font-semibold underline" href="/app/plugins">
                {t("settings.openPlugins")}
              </a>
            </p>
          )}
          {operation && (
            <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm">
              <p className="font-semibold text-indigo-950">
                {t(stageKeys[operation.state])} · {operation.targetVersion}
              </p>
              <p className="mt-1 text-indigo-800">
                {t("settings.keepPageOpen")}
              </p>
            </div>
          )}
          <p className="mt-4 text-xs text-slate-500">
            {t("settings.backupNotice")}
          </p>
        </Card>
      </div>
    </div>
  );
}
