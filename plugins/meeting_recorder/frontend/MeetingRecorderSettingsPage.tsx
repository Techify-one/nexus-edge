import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ExternalLink,
  HardDrive,
  KeyRound,
  Link2,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Button,
  Card,
  Input,
  Label,
  PageHeader,
  PasswordInput,
  Select,
  Skeleton,
  ToggleSwitch,
} from "../../../frontend/src/components/ui/index.js";
import {
  ApiError,
  api,
  idempotencyKey,
  recentReauthHeaders,
} from "../../../frontend/src/lib/api/core-client.js";
import { cloudflareR2TokenTemplateUrl } from "../../../frontend/src/lib/cloudflare-token.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import { recorderApi } from "./api-client.js";
import { MeetingRecorderRouteGate } from "./MeetingRecorderRouteGate.js";
import { TelegramAccessCard } from "./TelegramAccessCard.js";

const randomSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

function SettingsContent() {
  const { t } = useI18n();
  const client = useQueryClient();
  const canReadSettings = can("meeting_recorder.settings.read");
  const editable = can("meeting_recorder.settings.update");
  const canLinkTelegram = can("meeting_recorder.recording.create");
  const canActivateR2 = can("core.plugin.update") && can("core.plugin.read");
  const query = useQuery({
    queryKey: ["meeting-recorder", "settings"],
    queryFn: recorderApi.settings,
  });
  const [defaultLanguage, setDefaultLanguage] = useState<
    "pt-BR" | "en" | "auto"
  >("pt-BR");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [maximumMinutes, setMaximumMinutes] = useState(120);
  const [storageLimitMb, setStorageLimitMb] = useState(1024);
  const [botToken, setBotToken] = useState("");
  const [r2Token, setR2Token] = useState("");
  const [telegramLinkRequest, setTelegramLinkRequest] = useState<{
    url: string;
    expiresAt: number;
  } | null>(null);
  const runtimeCredential = useQuery({
    queryKey: ["plugin-runtime-credential"],
    queryFn: () =>
      api<{ configured: boolean; accountId: string }>(
        "/api/v1/plugin-runtime-credential",
      ),
    enabled:
      canActivateR2 &&
      Boolean(query.data && !query.data.capabilities.storageEnabled),
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!query.data) return;
    setDefaultLanguage(query.data.settings.defaultLanguage);
    setAutoTranscribe(query.data.settings.autoTranscribe);
    setMaximumMinutes(query.data.settings.maximumMinutes);
    setStorageLimitMb(
      Math.round(query.data.settings.storageLimitBytes / 1024 / 1024),
    );
  }, [query.data]);

  const save = useMutation({
    mutationFn: () =>
      recorderApi.saveSettings({
        defaultLanguage,
        autoTranscribe,
        maximumMinutes,
        storageLimitBytes: storageLimitMb * 1024 * 1024,
        version: query.data!.settings.version,
      }),
    onSuccess: () => {
      toast.success(t("meetingRecorder.settingsSaved"));
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "settings"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const linkTelegram = useMutation({
    mutationFn: recorderApi.createTelegramLinkRequest,
    onSuccess: (link) => {
      setTelegramLinkRequest(link);
      toast.success(t("meetingRecorder.telegramLinkReady"));
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const telegram = useMutation({
    mutationFn: async () => {
      if (botToken.trim().length < 20)
        throw new Error(t("meetingRecorder.telegramTokenInvalid"));
      await recorderApi.validateTelegram(botToken.trim());
      const webhookSecret = randomSecret();
      const reauth = await recentReauthHeaders(
        t("meetingRecorder.telegramPassword"),
      );
      if (
        query.data?.telegram.botTokenConfigured ||
        query.data?.telegram.webhookSecretConfigured
      )
        await recorderApi.disconnectTelegram(reauth);
      await api(
        "/api/v1/plugins/meeting_recorder/runtime-secrets/TELEGRAM_BOT_TOKEN",
        {
          method: "PUT",
          headers: reauth,
          body: JSON.stringify({ value: botToken.trim() }),
        },
      );
      await api(
        "/api/v1/plugins/meeting_recorder/runtime-secrets/TELEGRAM_WEBHOOK_SECRET",
        {
          method: "PUT",
          headers: reauth,
          body: JSON.stringify({ value: webhookSecret }),
        },
      );
      setBotToken("");
      const webhookUrl = `${window.location.origin}/api/v1/public/p/meeting_recorder/telegram/webhook`;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        try {
          return await recorderApi.configureTelegram(webhookUrl);
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            error.code !== "TELEGRAM_NOT_CONFIGURED" ||
            attempt === 11
          )
            throw error;
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
      }
    },
    onSuccess: () => {
      toast.success(t("meetingRecorder.telegramConfigured"));
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "settings"],
      });
      if (canLinkTelegram) linkTelegram.mutate();
    },
    onError: (error: Error) => {
      setBotToken("");
      toast.error(error.message);
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "settings"],
      });
    },
  });
  const verifyTelegram = useMutation({
    mutationFn: () => {
      const webhookUrl = `${window.location.origin}/api/v1/public/p/meeting_recorder/telegram/webhook`;
      return recorderApi.configureTelegram(webhookUrl);
    },
    onSuccess: (result) => {
      toast.success(
        t(
          result.webhookChanged
            ? "meetingRecorder.telegramWebhookCorrected"
            : "meetingRecorder.telegramWebhookVerified",
        ),
      );
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "settings"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const disconnectTelegram = useMutation({
    mutationFn: async () => {
      const reauth = await recentReauthHeaders(
        t("meetingRecorder.telegramDisconnectPassword"),
      );
      await recorderApi.disconnectTelegram(reauth);
      await api(
        "/api/v1/plugins/meeting_recorder/runtime-secrets/TELEGRAM_BOT_TOKEN",
        { method: "DELETE", headers: reauth },
      );
      await api(
        "/api/v1/plugins/meeting_recorder/runtime-secrets/TELEGRAM_WEBHOOK_SECRET",
        { method: "DELETE", headers: reauth },
      );
    },
    onSuccess: () => {
      setBotToken("");
      setTelegramLinkRequest(null);
      toast.success(t("meetingRecorder.telegramDisconnected"));
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "settings"],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });
  const activateR2 = useMutation({
    mutationFn: async () => {
      const token = r2Token.trim();
      if (token.length < 40)
        throw new Error(t("meetingRecorder.r2TokenInvalid"));
      const reauth = await recentReauthHeaders(
        t("meetingRecorder.r2ReauthPassword"),
      );
      await api("/api/v1/plugins/meeting_recorder/runtime-resources/r2", {
        method: "POST",
        headers: { ...reauth, "Idempotency-Key": idempotencyKey() },
        body: JSON.stringify({ token, mode: "create" }),
      });
      setR2Token("");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          const status = await recorderApi.settings();
          if (status.capabilities.storageEnabled) return status;
        } catch {
          // Binding changes publish a Worker version; retry during propagation.
        }
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      throw new Error(t("meetingRecorder.r2ActivationPending"));
    },
    onSuccess: (status) => {
      client.setQueryData(["meeting-recorder", "settings"], status);
      void client.invalidateQueries({
        queryKey: ["meeting-recorder", "defaults"],
      });
      toast.success(t("meetingRecorder.r2Activated"));
    },
    onError: (error: Error) => {
      setR2Token("");
      toast.error(error.message);
    },
  });

  if (query.isPending) return <Skeleton className="h-96" />;
  if (!query.data) return null;
  const telegramUserLink = query.data.telegram.userLink ?? {
    linked: false,
    telegramId: null,
    username: null,
  };
  return (
    <>
      <PageHeader
        title={t("meetingRecorder.settings")}
        description={t("meetingRecorder.settingsDescription")}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        {canReadSettings && (
          <Card>
            <div className="mb-5 flex items-center gap-3">
              <HardDrive className="h-5 w-5 text-indigo-600" />
              <div>
                <h2 className="font-bold">{t("meetingRecorder.r2Title")}</h2>
                <p className="text-sm text-slate-500">
                  {t("meetingRecorder.r2Description")}
                </p>
              </div>
            </div>
            {query.data.capabilities.storageEnabled ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
                {t("meetingRecorder.r2Enabled")}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                  {t("meetingRecorder.r2Disabled")}
                </div>
                {canActivateR2 && runtimeCredential.data && (
                  <>
                    <a
                      className="inline-flex items-center gap-1 font-medium text-indigo-700 underline"
                      href={cloudflareR2TokenTemplateUrl(
                        runtimeCredential.data.accountId,
                      )}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      {t("meetingRecorder.r2CreateToken")}
                      <ExternalLink className="h-4 w-4" />
                    </a>
                    <p className="text-xs text-slate-500">
                      {t("meetingRecorder.r2TokenInstructions")}
                    </p>
                    <Label htmlFor="meeting-recorder-r2-token">
                      {t("meetingRecorder.r2Token")}
                    </Label>
                    <PasswordInput
                      id="meeting-recorder-r2-token"
                      autoComplete="off"
                      minLength={40}
                      maxLength={2048}
                      value={r2Token}
                      onChange={(event) => setR2Token(event.target.value)}
                    />
                    <Button
                      busy={activateR2.isPending}
                      disabled={r2Token.trim().length < 40}
                      onClick={() => activateR2.mutate()}
                    >
                      <HardDrive className="h-4 w-4" />
                      {t("meetingRecorder.r2Activate")}
                    </Button>
                  </>
                )}
                {!canActivateR2 && (
                  <p className="text-sm text-slate-500">
                    {t("meetingRecorder.r2AdminRequired")}
                  </p>
                )}
              </div>
            )}
          </Card>
        )}
        {canReadSettings && (
          <Card>
            <div className="mb-5 flex items-center gap-3">
              <Save className="h-5 w-5 text-indigo-600" />
              <h2 className="font-bold">{t("meetingRecorder.defaults")}</h2>
            </div>
            <div className="space-y-4">
              <div>
                <Label htmlFor="default-language">{t("common.language")}</Label>
                <Select
                  id="default-language"
                  value={defaultLanguage}
                  onChange={(event) =>
                    setDefaultLanguage(
                      event.target.value as typeof defaultLanguage,
                    )
                  }
                >
                  <option value="pt-BR">Português</option>
                  <option value="en">English</option>
                  <option value="auto">
                    {t("meetingRecorder.autoLanguage")}
                  </option>
                </Select>
              </div>
              <div>
                <Label htmlFor="maximum-minutes">
                  {t("meetingRecorder.maximumMinutes")}
                </Label>
                <Input
                  id="maximum-minutes"
                  type="number"
                  min={1}
                  max={240}
                  value={maximumMinutes}
                  onChange={(event) =>
                    setMaximumMinutes(Number(event.target.value))
                  }
                />
              </div>
              <div>
                <Label htmlFor="storage-limit">
                  {t("meetingRecorder.storageLimit")}
                </Label>
                <Input
                  id="storage-limit"
                  type="number"
                  min={100}
                  max={8192}
                  value={storageLimitMb}
                  disabled={!query.data.capabilities.storageEnabled}
                  onChange={(event) =>
                    setStorageLimitMb(Number(event.target.value))
                  }
                />
              </div>
              <label className="flex items-center justify-between gap-4 rounded-xl border p-3 text-sm">
                <span>{t("meetingRecorder.autoTranscribe")}</span>
                <ToggleSwitch
                  checked={autoTranscribe}
                  onClick={() => setAutoTranscribe((value) => !value)}
                  aria-label={t("meetingRecorder.autoTranscribe")}
                />
              </label>
              {editable && (
                <Button busy={save.isPending} onClick={() => save.mutate()}>
                  <Save className="h-4 w-4" />
                  {t("common.save")}
                </Button>
              )}
            </div>
          </Card>
        )}
        <Card>
          <div className="mb-5 flex items-center gap-3">
            <Bot className="h-5 w-5 text-indigo-600" />
            <div>
              <h2 className="font-bold">{t("meetingRecorder.telegram")}</h2>
              <p className="text-sm text-slate-500">
                {t("meetingRecorder.telegramDescription")}
              </p>
            </div>
          </div>
          <div className="mb-4 rounded-xl bg-slate-50 p-3 text-sm">
            {query.data.telegram.configured
              ? t("meetingRecorder.telegramReady")
              : t("meetingRecorder.telegramNotConfigured")}
          </div>
          <div className="mb-4 rounded-xl border border-slate-200 p-3 text-sm text-slate-700">
            {query.data.capabilities.telegramTransientMode
              ? t("meetingRecorder.telegramTransientMode")
              : t("meetingRecorder.telegramStoredMode")}
          </div>
          {query.data.telegram.bot && query.data.telegram.webhook && (
            <div className="mb-4 space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
              <p className="font-semibold">
                {query.data.telegram.bot.name} · @
                {query.data.telegram.bot.username}
              </p>
              <p>
                {t("meetingRecorder.telegramBotId")}:{" "}
                {query.data.telegram.bot.id}
              </p>
              <p className="break-all text-xs">
                {t("meetingRecorder.telegramWebhook")}:{" "}
                {query.data.telegram.webhook.url}
              </p>
              <a
                className="inline-flex items-center gap-1 font-semibold text-indigo-700 underline"
                href={query.data.telegram.bot.link}
                target="_blank"
                rel="noreferrer noopener"
              >
                {t("meetingRecorder.openTelegramBot")}
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          )}
          {query.data.telegram.configured && canLinkTelegram && (
            <div className="mb-4 space-y-3 rounded-xl border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
              <div>
                <p className="font-semibold">
                  {telegramUserLink.linked
                    ? t("meetingRecorder.telegramUserLinked")
                    : t("meetingRecorder.telegramUserNotLinked")}
                </p>
                {telegramUserLink.telegramId && (
                  <p className="mt-1 text-xs">
                    {t("meetingRecorder.telegramLinkedId")}:{" "}
                    {telegramUserLink.telegramId}
                    {telegramUserLink.username
                      ? ` · @${telegramUserLink.username}`
                      : ""}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  busy={linkTelegram.isPending}
                  onClick={() => linkTelegram.mutate()}
                >
                  <Link2 className="h-4 w-4" />
                  {t(
                    telegramUserLink.linked
                      ? "meetingRecorder.telegramRelink"
                      : "meetingRecorder.telegramLink",
                  )}
                </Button>
                <Button
                  variant="ghost"
                  busy={query.isFetching}
                  onClick={() => void query.refetch()}
                >
                  <RefreshCw className="h-4 w-4" />
                  {t("meetingRecorder.telegramCheckLink")}
                </Button>
              </div>
              {telegramLinkRequest && (
                <div className="rounded-lg border border-indigo-200 p-3">
                  <p className="mb-2 text-xs">
                    {t("meetingRecorder.telegramLinkInstructions")}
                  </p>
                  <a
                    className="inline-flex items-center gap-1 font-semibold text-indigo-700 underline"
                    href={telegramLinkRequest.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {t("meetingRecorder.telegramOpenLink")}
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </div>
              )}
            </div>
          )}
          {editable && (
            <>
              <Label htmlFor="telegram-token">
                {t("meetingRecorder.telegramToken")}
              </Label>
              <PasswordInput
                id="telegram-token"
                autoComplete="off"
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
                placeholder="123456:AA…"
              />
              <p className="mt-2 text-xs text-slate-500">
                {t("meetingRecorder.telegramPrivacy")}
              </p>
              <p className="mt-2 text-xs text-slate-500">
                {t("meetingRecorder.telegramUserLink")}
              </p>
              <Button
                className="mt-4"
                busy={telegram.isPending}
                disabled={!botToken.trim()}
                onClick={() => telegram.mutate()}
              >
                <KeyRound className="h-4 w-4" />
                {t(
                  query.data.telegram.configured
                    ? "meetingRecorder.replaceTelegram"
                    : "meetingRecorder.configureTelegram",
                )}
              </Button>
              {(query.data.telegram.botTokenConfigured ||
                query.data.telegram.webhookSecretConfigured) && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    busy={verifyTelegram.isPending}
                    onClick={() => verifyTelegram.mutate()}
                  >
                    <RefreshCw className="h-4 w-4" />
                    {t("meetingRecorder.verifyTelegramWebhook")}
                  </Button>
                  <Button
                    variant="danger"
                    busy={disconnectTelegram.isPending}
                    onClick={() =>
                      confirm(t("meetingRecorder.telegramDisconnectConfirm")) &&
                      disconnectTelegram.mutate()
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("meetingRecorder.disconnectTelegram")}
                  </Button>
                </div>
              )}
            </>
          )}
        </Card>
        <TelegramAccessCard configured={query.data.telegram.configured} />
      </div>
    </>
  );
}

export default function MeetingRecorderSettingsPage() {
  return (
    <MeetingRecorderRouteGate>
      <SettingsContent />
    </MeetingRecorderRouteGate>
  );
}
