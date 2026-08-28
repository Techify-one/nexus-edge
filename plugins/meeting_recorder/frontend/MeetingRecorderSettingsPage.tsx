import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, KeyRound, Save } from "lucide-react";
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
  recentReauthHeaders,
} from "../../../frontend/src/lib/api/core-client.js";
import { useI18n } from "../../../frontend/src/i18n/index.js";
import { can } from "../../../frontend/src/lib/ability.js";
import { recorderApi } from "./api-client.js";
import { MeetingRecorderRouteGate } from "./MeetingRecorderRouteGate.js";

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
  const editable = can("meeting_recorder.settings.update");
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
  const telegram = useMutation({
    mutationFn: async () => {
      if (botToken.trim().length < 20)
        throw new Error(t("meetingRecorder.telegramTokenInvalid"));
      const webhookSecret = randomSecret();
      const reauth = await recentReauthHeaders(
        t("meetingRecorder.telegramPassword"),
      );
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
          await recorderApi.configureTelegram(webhookUrl);
          return;
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
    },
    onError: (error: Error) => {
      setBotToken("");
      toast.error(error.message);
    },
  });

  if (query.isPending) return <Skeleton className="h-96" />;
  if (!query.data) return null;
  return (
    <>
      <PageHeader
        title={t("meetingRecorder.settings")}
        description={t("meetingRecorder.settingsDescription")}
      />
      <div className="grid gap-5 lg:grid-cols-2">
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
            {query.data.telegram.botTokenConfigured &&
            query.data.telegram.webhookSecretConfigured
              ? t("meetingRecorder.telegramReady")
              : t("meetingRecorder.telegramNotConfigured")}
          </div>
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
                {t("meetingRecorder.configureTelegram")}
              </Button>
            </>
          )}
        </Card>
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
