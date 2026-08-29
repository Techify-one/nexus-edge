import { MeetingRecorderError } from "./errors.js";

export type TelegramMedia = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_size?: number;
  mime_type?: string;
  file_name?: string;
  title?: string;
};

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type?: string };
    voice?: TelegramMedia;
    audio?: TelegramMedia;
  };
};

type TelegramEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};
export type TelegramBotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};
export type TelegramWebhookInfo = {
  url: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
};
const MAX_TELEGRAM_AUDIO_BYTES = 20 * 1024 * 1024;

const apiUrl = (token: string, method: string): URL => {
  if (!/^\d{6,15}:[A-Za-z0-9_-]{20,}$/u.test(token))
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "The Telegram bot token is missing or invalid.",
    );
  return new URL(`/bot${token}/${method}`, "https://api.telegram.org");
};

async function telegramCall<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(apiUrl(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await response
    .json()
    .catch(() => null)) as TelegramEnvelope<T> | null;
  if (!response.ok || !data?.ok || data.result === undefined)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_API_ERROR",
      "Telegram rejected the bot operation.",
    );
  return data.result;
}

export async function configureTelegramWebhook(input: {
  token: string;
  secret: string;
  webhookUrl: string;
}): Promise<{
  bot: TelegramBotIdentity;
  webhook: TelegramWebhookInfo;
  webhookChanged: boolean;
}> {
  const url = new URL(input.webhookUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith("/api/v1/public/p/meeting_recorder/telegram/webhook")
  )
    throw new MeetingRecorderError(
      422,
      "TELEGRAM_WEBHOOK_URL_INVALID",
      "The Telegram webhook URL is invalid.",
    );
  if (!/^[A-Za-z0-9_-]{20,256}$/u.test(input.secret))
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "The Telegram webhook secret is missing or invalid.",
    );
  const [bot, currentWebhook] = await Promise.all([
    telegramCall<TelegramBotIdentity>(input.token, "getMe", {}),
    telegramCall<TelegramWebhookInfo>(input.token, "getWebhookInfo", {}),
  ]);
  if (
    !bot.is_bot ||
    !Number.isSafeInteger(bot.id) ||
    !bot.first_name?.trim() ||
    !bot.username ||
    !/^[A-Za-z0-9_]{5,32}$/u.test(bot.username)
  )
    throw new MeetingRecorderError(
      422,
      "TELEGRAM_BOT_INVALID",
      "Telegram did not return a valid bot identity.",
    );
  const webhookChanged = currentWebhook.url !== url.toString();
  // Set the webhook even when the URL already matches so the secret token and
  // allowed update policy are guaranteed to match this Nexus installation.
  await telegramCall<boolean>(input.token, "setWebhook", {
    url: url.toString(),
    secret_token: input.secret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
    max_connections: 10,
  });
  const webhook = await telegramCall<TelegramWebhookInfo>(
    input.token,
    "getWebhookInfo",
    {},
  );
  if (webhook.url !== url.toString())
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_WEBHOOK_VERIFICATION_FAILED",
      "Telegram did not confirm the configured webhook URL.",
    );
  return { bot, webhook, webhookChanged };
}

export async function validateTelegramBot(
  token: string,
): Promise<TelegramBotIdentity> {
  const bot = await telegramCall<TelegramBotIdentity>(token, "getMe", {});
  if (
    !bot.is_bot ||
    !Number.isSafeInteger(bot.id) ||
    !bot.first_name?.trim() ||
    !bot.username ||
    !/^[A-Za-z0-9_]{5,32}$/u.test(bot.username)
  )
    throw new MeetingRecorderError(
      422,
      "TELEGRAM_BOT_INVALID",
      "Telegram did not return a valid bot identity.",
    );
  return bot;
}

export async function deleteTelegramWebhook(token: string): Promise<void> {
  await telegramCall<boolean>(token, "deleteWebhook", {
    drop_pending_updates: false,
  });
}

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<void> {
  await telegramCall<{ message_id: number }>(token, "sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4_096),
    disable_web_page_preview: true,
  });
}

export async function downloadTelegramMedia(
  token: string,
  media: TelegramMedia,
): Promise<{ bytes: ArrayBuffer; mimeType: string; fileName?: string }> {
  const file = await telegramCall<{ file_path?: string; file_size?: number }>(
    token,
    "getFile",
    { file_id: media.file_id },
  );
  if (
    !file.file_path ||
    !/^[A-Za-z0-9_./-]{1,512}$/u.test(file.file_path) ||
    file.file_path.includes("..")
  )
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_FILE_INVALID",
      "Telegram returned an invalid file path.",
    );
  const fileUrl = new URL(
    `/file/bot${token}/${file.file_path}`,
    "https://api.telegram.org",
  );
  let response: Response;
  try {
    // Telegram may move file delivery between its API and CDN. The URL is
    // derived exclusively from Telegram's validated getFile response and no
    // credentials are sent as headers, so following that provider redirect is
    // both necessary and bounded to this download operation.
    response = await fetch(fileUrl, { redirect: "follow" });
  } catch {
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_FILE_UNAVAILABLE",
      "Telegram could not provide the audio file.",
    );
  }
  if (!response.ok)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_FILE_UNAVAILABLE",
      "Telegram could not provide the audio file.",
    );
  const declaredSize = Number(response.headers.get("Content-Length") ?? 0);
  if (declaredSize > MAX_TELEGRAM_AUDIO_BYTES)
    throw new MeetingRecorderError(
      413,
      "AUDIO_IMPORT_TOO_LARGE",
      "Telegram audio exceeds 20 MiB.",
    );
  if (!response.body)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_FILE_UNAVAILABLE",
      "Telegram returned an empty audio response.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_TELEGRAM_AUDIO_BYTES) {
        await reader.cancel();
        throw new MeetingRecorderError(
          413,
          "AUDIO_IMPORT_TOO_LARGE",
          "Telegram audio exceeds 20 MiB.",
        );
      }
      chunks.push(value);
    }
  } catch (cause) {
    if (cause instanceof MeetingRecorderError) throw cause;
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_FILE_UNAVAILABLE",
      "Telegram interrupted the audio download.",
    );
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes: bytes.buffer,
    mimeType:
      media.mime_type ||
      response.headers.get("Content-Type") ||
      (media.file_name?.endsWith(".mp3") ? "audio/mpeg" : "audio/ogg"),
    ...(media.file_name ? { fileName: media.file_name } : {}),
  };
}

export function telegramSecretMatches(
  expected: string | undefined,
  received: string | undefined,
): boolean {
  if (!expected || !received || expected.length !== received.length)
    return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1)
    difference |= expected.charCodeAt(index) ^ received.charCodeAt(index);
  return difference === 0;
}
