import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";

type JsonObject = Record<string, unknown>;
type Operation = {
  operationId: string;
  pluginId: string;
  state: string;
  failureReason?: string;
  failureDetail?: string;
};

class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string | undefined,
  ) {
    super(`${code} (HTTP ${status})`);
  }
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const origin = new URL(required("TEST_CORE_URL"));
if (
  origin.protocol !== "https:" ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("TEST_CORE_URL must be an HTTPS origin without a path.");
if (
  origin.hostname === "hub.francisconeto.net.br" ||
  origin.hostname === "modular-workers-core.francisconeto.workers.dev"
)
  throw new Error("The API installation test refuses to target production.");

const adminEmail = required("TEST_ADMIN_EMAIL");
const adminPassword = required("TEST_ADMIN_PASSWORD");
const r2Token = required("TEST_R2_TOKEN");
const packagePath = resolve(
  process.env.TEST_PLUGIN_PACKAGE ??
    "plugins/meeting_recorder/release/meeting_recorder.plugin.zip",
);
const cookieJar = new Map<string, string>();

const updateCookies = (response: Response): void => {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values =
    headers.getSetCookie?.() ??
    (response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie")!]
      : []);
  for (const value of values) {
    const pair = value.split(";", 1)[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const content = pair.slice(separator + 1);
    if (!content || /max-age=0/iu.test(value)) cookieJar.delete(name);
    else cookieJar.set(name, content);
  }
};

const request = async (
  path: string,
  init: RequestInit = {},
): Promise<Response> => {
  if (!path.startsWith("/")) throw new Error("API path must be absolute.");
  const headers = new Headers(init.headers);
  headers.set("Accept", headers.get("Accept") ?? "application/json");
  headers.set("Accept-Language", "en");
  headers.set("Origin", origin.origin);
  if (cookieJar.size)
    headers.set(
      "Cookie",
      [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; "),
    );
  const response = await fetch(new URL(path, origin), {
    ...init,
    headers,
    redirect: "manual",
  });
  updateCookies(response);
  if (!response.ok) {
    const envelope = (await response.json().catch(() => ({}))) as {
      error?: { code?: string; requestId?: string };
      code?: string;
    };
    throw new ApiFailure(
      response.status,
      envelope.error?.code ?? envelope.code ?? "HTTP_ERROR",
      envelope.error?.requestId,
    );
  }
  return response;
};

const json = async <T extends JsonObject>(
  path: string,
  init: RequestInit = {},
): Promise<T> => (await request(path, init)).json() as Promise<T>;

const jsonBody = (value: unknown): Pick<RequestInit, "body" | "headers"> => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});

const archive = unzipSync(readFileSync(packagePath));
const requiredArchiveFile = (path: string): Uint8Array<ArrayBuffer> => {
  const value = archive[path];
  if (!value) throw new Error(`Plugin archive is missing ${path}.`);
  return value as Uint8Array<ArrayBuffer>;
};
const manifestText = strFromU8(requiredArchiveFile("manifest.json"));
const manifest = JSON.parse(manifestText) as {
  id?: string;
  version?: string;
  coreMinVersion?: string;
};
if (manifest.id !== "meeting_recorder")
  throw new Error("The selected package is not meeting_recorder.");

const packageBody = (): FormData => {
  const form = new FormData();
  form.set("manifest", manifestText);
  form.set(
    "worker",
    new File([requiredArchiveFile("worker.mjs")], "worker.mjs", {
      type: "application/javascript+module",
    }),
  );
  form.set(
    "d1Migrations",
    JSON.stringify({
      "0001_init": strFromU8(
        requiredArchiveFile("migrations/d1/0001_init.sql"),
      ),
    }),
  );
  form.set(
    "postgresMigrations",
    JSON.stringify({
      "0001_init": strFromU8(
        requiredArchiveFile("migrations/postgres/0001_init.sql"),
      ),
    }),
  );
  return form;
};

const state = await json<{ state: string }>("/api/v1/setup/status");
if (state.state === "open" || state.state === "claimed")
  await json("/api/v1/setup/first-admin", {
    method: "POST",
    ...jsonBody({
      name: "Meeting Recorder API Test",
      email: adminEmail,
      password: adminPassword,
    }),
  });
else if (state.state !== "complete")
  throw new Error(`Unexpected setup state: ${state.state}`);

await json("/api/auth/sign-in/email", {
  method: "POST",
  ...jsonBody({ email: adminEmail, password: adminPassword }),
});
await json("/api/v1/me");

let operation = await json<Operation>("/api/v1/plugin-operations", {
  method: "POST",
  headers: { "Idempotency-Key": `install-${randomUUID()}` },
  body: packageBody(),
});
const visitedStates = [operation.state];

for (
  let attempt = 0;
  attempt < 40 && operation.state !== "installed";
  attempt += 1
) {
  if (operation.state === "provisioning") {
    const reauth = await json<{ token: string }>("/api/v1/auth/reauth", {
      method: "POST",
      ...jsonBody({ password: adminPassword }),
    });
    operation = await json<Operation>(
      `/api/v1/plugin-operations/${encodeURIComponent(operation.operationId)}/provision-r2`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `r2-${operation.operationId}`,
          "X-Reauth-Token": reauth.token,
        },
        body: JSON.stringify({ token: r2Token, mode: "create" }),
      },
    );
  } else {
    if (operation.state === "registering")
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    try {
      operation = await json<Operation>(
        `/api/v1/plugin-operations/${encodeURIComponent(operation.operationId)}/advance`,
        { method: "POST", body: packageBody() },
      );
    } catch (error) {
      if (!(error instanceof ApiFailure)) throw error;
      const diagnostic = await json<Operation>(
        `/api/v1/plugin-operations/${encodeURIComponent(operation.operationId)}`,
      );
      if (diagnostic.failureReason !== "service_binding_pending") throw error;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      operation = await json<Operation>(
        `/api/v1/plugin-operations/${encodeURIComponent(operation.operationId)}/resume`,
        { method: "POST" },
      );
    }
  }
  visitedStates.push(operation.state);
  if (operation.state === "failed")
    throw new Error(
      `Installation failed: ${operation.failureReason ?? "unknown"}`,
    );
}
if (operation.state !== "installed")
  throw new Error(`Installation did not finish: ${operation.state}`);

const health = await json<{ ok: boolean; plugin: string; version: string }>(
  "/api/v1/p/meeting_recorder/health",
);
if (!health.ok || health.plugin !== "meeting_recorder")
  throw new Error("Installed plugin health check failed.");

const telegramSecret = randomBytes(32).toString("base64url");
const telegramReauth = await json<{ token: string }>("/api/v1/auth/reauth", {
  method: "POST",
  ...jsonBody({ password: adminPassword }),
});
const telegramSecretHeaders = {
  "Content-Type": "application/json",
  "X-Reauth-Token": telegramReauth.token,
};
const runtimeSecretPath = (name: string): string =>
  `/api/v1/plugins/meeting_recorder/runtime-secrets/${name}`;
let telegramWebhookValidated = false;
try {
  await request(runtimeSecretPath("TELEGRAM_BOT_TOKEN"), {
    method: "PUT",
    headers: telegramSecretHeaders,
    body: JSON.stringify({ value: `123456:${"t".repeat(24)}` }),
  });
  await request(runtimeSecretPath("TELEGRAM_WEBHOOK_SECRET"), {
    method: "PUT",
    headers: telegramSecretHeaders,
    body: JSON.stringify({ value: telegramSecret }),
  });
  const webhookUrl = new URL(
    "/api/v1/public/p/meeting_recorder/telegram/webhook",
    origin,
  );
  const update = {
    update_id: Number(String(Date.now()).slice(-12)),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1_000),
      from: { id: 9_000_000_001 },
      chat: { id: 9_000_000_001 },
    },
  };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": telegramSecret,
      },
      body: JSON.stringify(update),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      ignored?: boolean;
      replay?: boolean;
      error?: { code?: string };
    };
    if (response.ok && payload.ok && (payload.ignored || payload.replay)) {
      telegramWebhookValidated = true;
      break;
    }
    if (
      response.status !== 401 ||
      payload.error?.code !== "TELEGRAM_WEBHOOK_UNAUTHORIZED" ||
      attempt === 19
    )
      throw new Error(
        `Telegram webhook probe failed (HTTP ${response.status}, ${payload.error?.code ?? "unknown"}).`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const rejected = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "x".repeat(32),
    },
    body: JSON.stringify({ ...update, update_id: update.update_id + 1 }),
  });
  const rejectedPayload = (await rejected.json().catch(() => ({}))) as {
    error?: { code?: string };
  };
  if (
    rejected.status !== 401 ||
    rejectedPayload.error?.code !== "TELEGRAM_WEBHOOK_UNAUTHORIZED"
  )
    throw new Error("Telegram webhook accepted an invalid secret.");
} finally {
  for (const name of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"])
    await request(runtimeSecretPath(name), {
      method: "DELETE",
      headers: { "X-Reauth-Token": telegramReauth.token },
    }).catch(() => undefined);
}
if (!telegramWebhookValidated)
  throw new Error("Telegram webhook propagation did not complete.");

let audioResult:
  | { recordingId: string; transcriptCharacters: number; rangeBytes: number }
  | undefined;
const audioPath = process.env.TEST_AUDIO_FILE?.trim();
if (audioPath) {
  const audio = readFileSync(resolve(audioPath));
  const extension = extname(audioPath).toLowerCase();
  const mimeType =
    extension === ".wav"
      ? "audio/wav"
      : extension === ".mp3"
        ? "audio/mpeg"
        : extension === ".m4a" || extension === ".mp4"
          ? "audio/mp4"
          : extension === ".webm"
            ? "audio/webm"
            : extension === ".ogg"
              ? "audio/ogg"
              : "";
  if (!mimeType) throw new Error("Unsupported TEST_AUDIO_FILE extension.");
  const durationMs = Number(process.env.TEST_AUDIO_DURATION_MS ?? "3000");
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000)
    throw new Error("TEST_AUDIO_DURATION_MS is invalid.");
  const clientSessionId = randomUUID();
  const checksum = createHash("sha256").update(audio).digest("base64");
  const created = await json<{
    recording: { id: string };
    uploadSequence: number;
  }>("/api/v1/p/meeting_recorder/imports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": `import-${clientSessionId}`,
    },
    body: JSON.stringify({
      clientSessionId,
      title: "Meeting Recorder API Test",
      fileName: `api-test${extension}`,
      mimeType,
      sizeBytes: audio.byteLength,
      durationMs,
      language: "en",
      autoTranscribe: false,
      consentVersion: "2026-08-28",
      consentAcknowledged: true,
    }),
  });
  const recordingId = created.recording.id;
  await request(
    `/api/v1/p/meeting_recorder/recordings/${encodeURIComponent(recordingId)}/segments/0`,
    {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "X-Segment-SHA256": checksum,
        "X-Segment-Bytes": String(audio.byteLength),
        "X-Segment-Duration-Ms": String(durationMs),
        "X-Segment-Start-Ms": "0",
        "X-Client-Session-Id": clientSessionId,
      },
      body: audio as unknown as BodyInit,
    },
  );
  const range = await request(
    `/api/v1/p/meeting_recorder/recordings/${encodeURIComponent(recordingId)}/segments/0/audio`,
    { headers: { Range: "bytes=0-127" } },
  );
  if (range.status !== 206)
    throw new Error(`Audio range check returned HTTP ${range.status}.`);
  const rangeBytes = (await range.arrayBuffer()).byteLength;
  await json(
    `/api/v1/p/meeting_recorder/recordings/${encodeURIComponent(recordingId)}/segments/0/transcribe`,
    {
      method: "POST",
      headers: {
        "Idempotency-Key": `transcribe-${recordingId}-0-${checksum}`,
      },
    },
  );
  const transcript = await json<{ text: string }>(
    `/api/v1/p/meeting_recorder/recordings/${encodeURIComponent(recordingId)}/transcript`,
  );
  const expected = process.env.TEST_EXPECTED_TRANSCRIPT?.trim().toLowerCase();
  if (expected && !transcript.text.toLowerCase().includes(expected))
    throw new Error("The transcript does not contain the expected test text.");
  if (!transcript.text.trim()) throw new Error("The transcript is empty.");
  audioResult = {
    recordingId,
    transcriptCharacters: transcript.text.length,
    rangeBytes,
  };
}

process.stdout.write(
  `${JSON.stringify(
    {
      success: true,
      coreOrigin: origin.origin,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
      coreMinVersion: manifest.coreMinVersion,
      operationId: operation.operationId,
      states: visitedStates,
      health,
      telegramWebhook: {
        signedUpdateAccepted: true,
        invalidSecretRejected: true,
        disposableSecretsRemoved: true,
      },
      ...(audioResult ? { audio: audioResult } : {}),
    },
    null,
    2,
  )}\n`,
);
