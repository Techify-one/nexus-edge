import { createDatabase } from "@app/database";
import { Hono, type Context } from "hono";
import { z, ZodError } from "zod";
import { pluginAudit } from "./audit.js";
import { contextMiddleware, requestId } from "./context.js";
import { MeetingRecorderError } from "./errors.js";
import type { MeetingRecorderEnv, MeetingRecorderBindings } from "./env.js";
import {
  requirePermission,
  requireRecordingAccess,
  telegramOwner,
  userContext,
} from "./permissions.js";
import {
  MeetingRecorderRepository,
  repositoryTime,
  type CaptureStatus,
  type Recording,
  type Segment,
} from "./repository.js";
import {
  IMPORT_MAX_BYTES,
  LIVE_SEGMENT_MAX_BYTES,
  base64Sha256,
  decodeSha256,
  extensionForMime,
  parseRange,
  putAudioBuffer,
  putAudioStream,
  segmentObjectKey,
} from "./storage.js";
import {
  configureTelegramWebhook,
  deleteTelegramWebhook,
  downloadTelegramMedia,
  sendTelegramMessage,
  telegramSecretMatches,
  type TelegramUpdate,
  validateTelegramBot,
} from "./telegram.js";
import {
  consumeTelegramInvitation,
  consumeTelegramLinkRequest,
  createTelegramInvitation,
  createTelegramLinkRequest,
  listTelegramAccess,
  revokeTelegramInvitation,
  revokeTelegramMember,
  telegramStartPayload,
  telegramUserLink,
} from "./telegram-links.js";
import { transcribeAudio } from "./transcription.js";

const VERSION = "1.2.0";
const CONSENT_VERSION = "2026-08-28";
const mutablePostKey = (c: Context<MeetingRecorderEnv>): string => {
  const key = (c.req.header("Idempotency-Key") ?? "").trim();
  if (!key || key.length > 200)
    throw new MeetingRecorderError(
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
      "A stable Idempotency-Key is required.",
    );
  return key;
};

const createRecordingInput = z.object({
  clientSessionId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  meetingPlatform: z
    .enum(["meet", "zoom_web", "teams_web", "other"])
    .optional(),
  sourceType: z.enum([
    "microphone",
    "tab",
    "display",
    "microphone_tab",
    "microphone_display",
  ]),
  language: z.enum(["pt-BR", "en", "auto"]),
  mimeType: z.string().trim().min(3).max(100),
  bitrateBps: z.number().int().min(8_000).max(512_000).optional(),
  segmentDurationMs: z.number().int().min(10_000).max(30_000),
  autoTranscribe: z.boolean().default(true),
  consentVersion: z.literal(CONSENT_VERSION),
  consentAcknowledged: z.literal(true),
});

const importInput = z.object({
  clientSessionId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().positive().max(IMPORT_MAX_BYTES),
  durationMs: z.number().int().min(1_000).max(14_400_000),
  language: z.enum(["pt-BR", "en", "auto"]),
  autoTranscribe: z.boolean().default(true),
  consentVersion: z.literal(CONSENT_VERSION),
  consentAcknowledged: z.literal(true),
});

const settingsInput = z.object({
  defaultLanguage: z.enum(["pt-BR", "en", "auto"]),
  autoTranscribe: z.boolean(),
  maximumMinutes: z.number().int().min(1).max(240),
  storageLimitBytes: z
    .number()
    .int()
    .min(100 * 1024 * 1024)
    .max(8 * 1024 * 1024 * 1024),
  version: z.number().int().nonnegative(),
});

const telegramInvitationInput = z.object({
  label: z.string().trim().min(1).max(100),
});

const telegramAccessId = z
  .string()
  .regex(/^tg[im]_[a-f0-9]{32}$/u)
  .max(40);

const repository = (c: Context<MeetingRecorderEnv>) =>
  new MeetingRecorderRepository(c.get("db"));

const requireStorage = (env: MeetingRecorderBindings): R2Bucket => {
  if (!env.STORAGE)
    throw new MeetingRecorderError(
      409,
      "R2_NOT_ENABLED",
      "Enable R2 storage to record, upload, retain, or play audio.",
    );
  return env.STORAGE;
};

const bool = (value: string | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === "true" || value === "1";

const boundedInteger = (
  value: string | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new MeetingRecorderError(
      422,
      "VALIDATION_ERROR",
      `${label} is invalid.`,
    );
  return parsed;
};

const recordingFor = async (
  c: Context<MeetingRecorderEnv>,
  base: string,
  override: string,
): Promise<Recording> => {
  const context = userContext(c);
  return requireRecordingAccess(
    context,
    await repository(c).recording(c.req.param("recordingId")!),
    base,
    override,
  );
};

const assertNotDeleting = (recording: Recording): void => {
  if (recording.captureStatus === "deleting")
    throw new MeetingRecorderError(
      409,
      "RECORDING_DELETING",
      "This recording is being deleted.",
    );
};

const segmentMatches = (
  segment: Segment,
  input: {
    checksum: string;
    sizeBytes: number;
    durationMs: number;
    startOffsetMs: number;
    mimeType: string;
  },
): boolean =>
  segment.checksumSha256 === input.checksum &&
  segment.sizeBytes === input.sizeBytes &&
  segment.durationMs === input.durationMs &&
  segment.startOffsetMs === input.startOffsetMs &&
  segment.mimeType === input.mimeType;

async function transcribeStoredSegment(input: {
  env: MeetingRecorderBindings;
  db: ReturnType<typeof repository>["db"];
  recording: Recording;
  segment: Segment;
  actorUserId: string;
  requestId: string;
}): Promise<void> {
  const repo = new MeetingRecorderRepository(input.db);
  const lease = await repo.claimTranscription(input.segment);
  try {
    const object = await requireStorage(input.env).get(input.segment.r2Key);
    if (!object)
      throw new MeetingRecorderError(
        503,
        "R2_UNAVAILABLE",
        "The stored audio is unavailable.",
      );
    const previous =
      input.segment.sequence > 0
        ? await repo.segment(input.recording.id, input.segment.sequence - 1)
        : null;
    const transcript = await transcribeAudio(
      input.env,
      await object.arrayBuffer(),
      input.recording.language,
      previous?.transcriptText ?? "",
    );
    await repo.completeTranscription(
      input.segment,
      lease,
      transcript.text,
      transcript.vtt,
    );
    await pluginAudit({
      db: input.db,
      action: "meeting_recorder.transcription.completed",
      resourceType: "meeting_recorder.recording",
      resourceId: input.recording.id,
      userId: input.actorUserId,
      requestId: input.requestId,
      logicalKey: `${input.recording.id}:${input.segment.sequence}:${input.segment.checksumSha256}`,
      metadata: { sequence: input.segment.sequence },
    });
  } catch (cause) {
    const code =
      cause instanceof MeetingRecorderError
        ? cause.code
        : "TRANSCRIPTION_FAILED";
    await repo.failTranscription(input.segment, lease, code);
    throw cause;
  }
}

async function transcribeTransientSegment(input: {
  env: MeetingRecorderBindings;
  db: ReturnType<typeof repository>["db"];
  recording: Recording;
  segment: Segment;
  bytes: ArrayBuffer;
  actorUserId: string;
  requestId: string;
}): Promise<void> {
  const repo = new MeetingRecorderRepository(input.db);
  const lease = await repo.claimTransientTranscription(input.segment);
  try {
    const transcript = await transcribeAudio(
      input.env,
      input.bytes,
      input.recording.language,
    );
    await repo.completeTranscription(
      input.segment,
      lease,
      transcript.text,
      transcript.vtt,
    );
    await pluginAudit({
      db: input.db,
      action: "meeting_recorder.transcription.completed",
      resourceType: "meeting_recorder.recording",
      resourceId: input.recording.id,
      userId: input.actorUserId,
      requestId: input.requestId,
      logicalKey: `${input.recording.id}:${input.segment.sequence}:${input.segment.checksumSha256}`,
      metadata: { sequence: input.segment.sequence, audioRetained: false },
    });
  } catch (cause) {
    const code =
      cause instanceof MeetingRecorderError
        ? cause.code
        : "TRANSCRIPTION_FAILED";
    await repo.failTranscription(input.segment, lease, code);
    throw cause;
  }
}

const app = new Hono<MeetingRecorderEnv>();

app.get("/health", (c) =>
  c.json({ ok: true, plugin: "meeting_recorder", version: VERSION }),
);
app.use("/*", contextMiddleware);
app.use("/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

app.post("/__installer/smoke", async (c) => {
  const context = c.get("installerContext");
  if (!context)
    throw new MeetingRecorderError(
      403,
      "INSTALLER_CONTEXT_REQUIRED",
      "Installer context required.",
    );
  const id = `mrr_smoke_${context.operationId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 80)}`;
  const now = repositoryTime(c.get("db"));
  const objectKey = `__nexus__/smoke/${context.operationId}`;
  await c.get("db").execute(
    `INSERT INTO meeting_recorder_recordings(
       id,client_session_id,owner_user_id,title,ingest_source,source_type,
       capture_status,transcription_status,language,mime_type,segment_duration_ms,
       auto_transcribe,consent_version,consent_acknowledged_at,started_at,created_at,updated_at
     ) VALUES (?,?,?,'Installer smoke','upload','file_upload','finalizing','off','auto',
       'audio/webm',10000,?,? ,?,?,?,?)`,
    [
      id,
      context.operationId,
      context.operationId,
      c.get("db").provider === "d1" ? 0 : false,
      CONSENT_VERSION,
      now,
      now,
      now,
      now,
    ],
  );
  try {
    if (typeof c.env.AI?.run !== "function")
      throw new Error("smoke verification failed");
    if (c.env.STORAGE) {
      await c.env.STORAGE.put(objectKey, new Uint8Array([1, 2, 3]), {
        httpMetadata: { contentType: "application/octet-stream" },
      });
      const object = await c.env.STORAGE.get(objectKey);
      if (!object || object.size !== 3)
        throw new Error("smoke verification failed");
    }
  } finally {
    await Promise.all([
      c.env.STORAGE?.delete(objectKey),
      c
        .get("db")
        .execute("DELETE FROM meeting_recorder_recordings WHERE id = ?", [id]),
    ]);
  }
  return c.json({
    ok: true,
    database: true,
    storage: Boolean(c.env.STORAGE),
    ai: true,
  });
});

app.get("/overview", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.read");
  return c.json(
    await repository(c).overview(
      context.userId,
      context.permissions.includes("meeting_recorder.recording.read_all"),
    ),
  );
});

app.get("/recordings", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.read");
  const limit = boundedInteger(c.req.query("limit") ?? "50", 1, 100, "limit");
  const query = c.req.query();
  const allowedStatus = new Set([
    "recording",
    "paused",
    "interrupted",
    "finalizing",
    "complete",
    "deleting",
  ]);
  const allowedSource = new Set(["live", "upload", "telegram"]);
  const allowedSort = new Set([
    "title",
    "status",
    "source",
    "duration",
    "size",
    "transcription",
    "owner",
    "started_at",
  ]);
  if (
    (query.status && !allowedStatus.has(query.status)) ||
    (query.source && !allowedSource.has(query.source)) ||
    (query.sort && !allowedSort.has(query.sort)) ||
    (query.direction && !["asc", "desc"].includes(query.direction))
  )
    throw new MeetingRecorderError(
      422,
      "VALIDATION_ERROR",
      "A recording list filter is invalid.",
    );
  return c.json(
    await repository(c).list({
      userId: context.userId,
      readAll: context.permissions.includes(
        "meeting_recorder.recording.read_all",
      ),
      ...(query.search ? { search: query.search } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.owner ? { owner: query.owner } : {}),
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.direction ? { direction: query.direction } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit,
    }),
  );
});

app.post("/recordings", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.create");
  requireStorage(c.env);
  mutablePostKey(c);
  const input = createRecordingInput.parse(await c.req.json());
  extensionForMime(input.mimeType);
  const recording = await repository(c).create({
    clientSessionId: input.clientSessionId,
    title: input.title,
    sourceType: input.sourceType,
    language: input.language,
    mimeType: input.mimeType,
    segmentDurationMs: input.segmentDurationMs,
    autoTranscribe: input.autoTranscribe,
    consentVersion: input.consentVersion,
    ...(input.meetingPlatform
      ? { meetingPlatform: input.meetingPlatform }
      : {}),
    ...(input.bitrateBps ? { bitrateBps: input.bitrateBps } : {}),
    ownerUserId: context.userId,
    ingestSource: "live",
  });
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.recording.created",
    resourceType: "meeting_recorder.recording",
    resourceId: recording.id,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: recording.id,
    metadata: { ingestSource: "live" },
  });
  return c.json({ recording }, 201);
});

app.post("/imports", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.create");
  requireStorage(c.env);
  mutablePostKey(c);
  const input = importInput.parse(await c.req.json());
  extensionForMime(input.mimeType);
  const settings = await repository(c).settings();
  if (input.durationMs > settings.maximumMinutes * 60_000)
    throw new MeetingRecorderError(
      422,
      "RECORDING_DURATION_LIMIT",
      "The audio exceeds the configured duration limit.",
    );
  const recording = await repository(c).create({
    clientSessionId: input.clientSessionId,
    ownerUserId: context.userId,
    title: input.title,
    ingestSource: "upload",
    originalFileName: input.fileName,
    sourceType: "file_upload",
    language: input.language,
    mimeType: input.mimeType,
    segmentDurationMs: input.durationMs,
    autoTranscribe: input.autoTranscribe,
    consentVersion: input.consentVersion,
  });
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.recording.created",
    resourceType: "meeting_recorder.recording",
    resourceId: recording.id,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: recording.id,
    metadata: { ingestSource: "upload" },
  });
  return c.json({ recording, uploadSequence: 0 }, 201);
});

app.get("/recordings/:recordingId", async (c) =>
  c.json({
    recording: await recordingFor(
      c,
      "meeting_recorder.recording.read",
      "meeting_recorder.recording.read_all",
    ),
  }),
);

app.patch("/recordings/:recordingId", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  assertNotDeleting(recording);
  const input = z
    .object({
      title: z.string().trim().min(1).max(200),
      version: z.number().int().positive(),
    })
    .parse(await c.req.json());
  const updated = await repository(c).updateTitle(
    recording.id,
    input.title,
    input.version,
  );
  if (!updated)
    throw new MeetingRecorderError(
      409,
      "VERSION_CONFLICT",
      "The recording changed before it could be saved.",
    );
  return c.json({ recording: updated });
});

app.put("/recordings/:recordingId/heartbeat", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  assertNotDeleting(recording);
  await repository(c).heartbeat(recording.id);
  return c.json({ ok: true });
});

app.put("/recordings/:recordingId/capture-state", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  assertNotDeleting(recording);
  const input = z
    .object({
      status: z.enum(["recording", "paused", "interrupted", "finalizing"]),
    })
    .parse(await c.req.json());
  const transitions: Record<string, string[]> = {
    recording: ["paused", "interrupted", "finalizing"],
    paused: ["recording", "interrupted", "finalizing"],
    interrupted: ["recording", "finalizing"],
    finalizing: [],
  };
  if (!transitions[recording.captureStatus]?.includes(input.status))
    throw new MeetingRecorderError(
      409,
      "INVALID_CAPTURE_STATE",
      "This capture-state transition is not allowed.",
    );
  await repository(c).setCaptureStatus(
    recording.id,
    input.status as CaptureStatus,
  );
  return c.json({ recording: await repository(c).recording(recording.id) });
});

app.get("/recordings/:recordingId/recovery", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  const segments = await repository(c).segments(recording.id);
  return c.json({
    recording,
    segments: segments.map((segment) => ({
      sequence: segment.sequence,
      checksumSha256: segment.checksumSha256,
      sizeBytes: segment.sizeBytes,
      storageStatus: segment.storageStatus,
    })),
  });
});

app.post("/recordings/:recordingId/reconcile", async (c) => {
  const storage = requireStorage(c.env);
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  mutablePostKey(c);
  assertNotDeleting(recording);
  if (
    (recording.captureStatus === "recording" ||
      recording.captureStatus === "paused") &&
    recording.effectiveCaptureStatus === "interrupted"
  )
    await repository(c).setCaptureStatus(recording.id, "interrupted");
  const candidates = (await repository(c).segments(recording.id))
    .filter((segment) => segment.storageStatus === "uploading")
    .slice(0, 25);
  let reconciled = 0;
  for (const segment of candidates) {
    const object = await storage.head(segment.r2Key);
    if (
      object &&
      object.size === segment.sizeBytes &&
      object.checksums.sha256 &&
      new Uint8Array(object.checksums.sha256).every(
        (value, index) =>
          value === new Uint8Array(decodeSha256(segment.checksumSha256))[index],
      )
    ) {
      await repository(c).markStored(segment, object);
      reconciled += 1;
    }
  }
  return c.json({
    reconciled,
    nextCursor:
      candidates.length === 25 ? String(candidates.at(-1)!.sequence) : null,
  });
});

app.get("/recordings/:recordingId/segments", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.read",
    "meeting_recorder.recording.read_all",
  );
  return c.json({ items: await repository(c).segments(recording.id) });
});

app.put("/recordings/:recordingId/segments/:sequence", async (c) => {
  const storageBucket = requireStorage(c.env);
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  assertNotDeleting(recording);
  if (
    !["recording", "paused", "interrupted", "finalizing"].includes(
      recording.captureStatus,
    )
  )
    throw new MeetingRecorderError(
      409,
      "RECORDING_FINALIZED",
      "This recording no longer accepts audio.",
    );
  const sequence = boundedInteger(
    c.req.param("sequence"),
    0,
    2_000,
    "sequence",
  );
  if ((c.req.header("X-Client-Session-Id") ?? "") !== recording.clientSessionId)
    throw new MeetingRecorderError(
      409,
      "CLIENT_SESSION_MISMATCH",
      "The client session does not match this recording.",
    );
  const sizeBytes = boundedInteger(
    c.req.header("X-Segment-Bytes"),
    1,
    recording.ingestSource === "live"
      ? LIVE_SEGMENT_MAX_BYTES
      : IMPORT_MAX_BYTES,
    "X-Segment-Bytes",
  );
  const durationMs = boundedInteger(
    c.req.header("X-Segment-Duration-Ms"),
    1_000,
    recording.ingestSource === "live" ? 35_000 : 14_400_000,
    "X-Segment-Duration-Ms",
  );
  const startOffsetMs = boundedInteger(
    c.req.header("X-Segment-Start-Ms"),
    0,
    14_400_000,
    "X-Segment-Start-Ms",
  );
  const checksum = c.req.header("X-Segment-SHA256") ?? "";
  decodeSha256(checksum);
  const mimeType = (c.req.header("Content-Type") ?? "").slice(0, 100);
  const existingSegment = await repository(c).segment(recording.id, sequence);
  if (
    existingSegment &&
    segmentMatches(existingSegment, {
      checksum,
      sizeBytes,
      durationMs,
      startOffsetMs,
      mimeType,
    }) &&
    existingSegment.storageStatus === "stored"
  )
    return c.json({ segment: existingSegment, replay: true }, 200);
  const [settings, storage] = await Promise.all([
    repository(c).settings(),
    repository(c).storageTotals(),
  ]);
  if (startOffsetMs + durationMs > settings.maximumMinutes * 60_000)
    throw new MeetingRecorderError(
      422,
      "RECORDING_DURATION_LIMIT",
      "The audio exceeds the configured duration limit.",
    );
  if (storage.totalBytes + sizeBytes > settings.storageLimitBytes)
    throw new MeetingRecorderError(
      413,
      "STORAGE_LIMIT_EXCEEDED",
      "The configured recording storage limit has been reached.",
    );
  const key = segmentObjectKey(recording.id, sequence, mimeType);
  const reserved = await repository(c).reserveSegment({
    recordingId: recording.id,
    sequence,
    startOffsetMs,
    durationMs,
    mimeType,
    sizeBytes,
    checksum,
    r2Key: key,
  });
  if (
    !segmentMatches(reserved.segment, {
      checksum,
      sizeBytes,
      durationMs,
      startOffsetMs,
      mimeType,
    })
  )
    throw new MeetingRecorderError(
      409,
      "SEGMENT_CONFLICT",
      "This sequence already contains different audio.",
    );
  if (reserved.segment.storageStatus === "stored")
    return c.json({ segment: reserved.segment, replay: true }, 200);
  if (!c.req.raw.body)
    throw new MeetingRecorderError(
      422,
      "AUDIO_BODY_REQUIRED",
      "The audio request body is required.",
    );
  const stored = await putAudioStream({
    storage: storageBucket,
    key,
    body: c.req.raw.body,
    mimeType,
    expectedBytes: sizeBytes,
    checksumBase64: checksum,
    maximumBytes:
      recording.ingestSource === "live"
        ? LIVE_SEGMENT_MAX_BYTES
        : IMPORT_MAX_BYTES,
    metadata: {
      recordingId: recording.id,
      sequence: String(sequence),
      durationMs: String(durationMs),
      checksum,
    },
  });
  await repository(c).markStored(reserved.segment, stored.object);
  if (recording.ingestSource !== "live")
    await repository(c).finalize(recording.id, 0, []);
  return c.json(
    {
      segment: await repository(c).segment(recording.id, sequence),
      replay: stored.replay,
    },
    stored.replay ? 200 : 201,
  );
});

app.on("HEAD", "/recordings/:recordingId/segments/:sequence", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  const sequence = boundedInteger(
    c.req.param("sequence"),
    0,
    2_000,
    "sequence",
  );
  const segment = await repository(c).segment(recording.id, sequence);
  if (!segment || segment.storageStatus !== "stored")
    throw new MeetingRecorderError(404, "NOT_FOUND", "Segment not found.");
  c.header("X-Segment-SHA256", segment.checksumSha256);
  c.header("Content-Length", String(segment.sizeBytes));
  return c.body(null, 200);
});

app.get("/recordings/:recordingId/segments/:sequence/audio", async (c) => {
  const storage = requireStorage(c.env);
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.read",
    "meeting_recorder.recording.read_all",
  );
  assertNotDeleting(recording);
  const sequence = boundedInteger(
    c.req.param("sequence"),
    0,
    2_000,
    "sequence",
  );
  const segment = await repository(c).segment(recording.id, sequence);
  if (!segment || segment.storageStatus !== "stored")
    throw new MeetingRecorderError(404, "NOT_FOUND", "Segment not found.");
  const head = await storage.head(segment.r2Key);
  if (!head)
    throw new MeetingRecorderError(
      503,
      "R2_UNAVAILABLE",
      "The stored audio is unavailable.",
    );
  let range: { offset: number; length: number } | null;
  try {
    range = parseRange(c.req.header("Range"), head.size);
  } catch (cause) {
    if (cause instanceof MeetingRecorderError && cause.status === 416) {
      c.header("Content-Range", `bytes */${head.size}`);
      throw cause;
    }
    throw cause;
  }
  const object = await storage.get(
    segment.r2Key,
    range ? { range } : undefined,
  );
  if (!object)
    throw new MeetingRecorderError(
      503,
      "R2_UNAVAILABLE",
      "The stored audio is unavailable.",
    );
  c.header("Accept-Ranges", "bytes");
  c.header("Content-Type", segment.mimeType);
  c.header("ETag", object.httpEtag);
  c.header("Content-Length", String(range?.length ?? head.size));
  if (range)
    c.header(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
    );
  return c.body(object.body, range ? 206 : 200);
});

app.post("/recordings/:recordingId/finalize", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.update",
    "meeting_recorder.recording.manage_all",
  );
  mutablePostKey(c);
  assertNotDeleting(recording);
  const input = z
    .object({
      expectedLastSequence: z.number().int().min(0).max(2_000),
      missingSequences: z
        .array(z.number().int().min(0).max(2_000))
        .max(2_001)
        .default([]),
    })
    .parse(await c.req.json());
  const updated = await repository(c).finalize(
    recording.id,
    input.expectedLastSequence,
    [...new Set(input.missingSequences)],
  );
  const context = userContext(c);
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.recording.finalized",
    resourceType: "meeting_recorder.recording",
    resourceId: recording.id,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `${recording.id}:${input.expectedLastSequence}`,
    metadata: { missingSegments: input.missingSequences.length },
  });
  return c.json({ recording: updated });
});

app.post(
  "/recordings/:recordingId/segments/:sequence/transcribe",
  async (c) => {
    const context = requirePermission(
      c,
      "meeting_recorder.transcription.create",
    );
    mutablePostKey(c);
    const recording = requireRecordingAccess(
      context,
      await repository(c).recording(c.req.param("recordingId")),
      "meeting_recorder.recording.read",
      "meeting_recorder.recording.read_all",
    );
    assertNotDeleting(recording);
    const sequence = boundedInteger(
      c.req.param("sequence"),
      0,
      2_000,
      "sequence",
    );
    const segment = await repository(c).segment(recording.id, sequence);
    if (!segment || segment.storageStatus !== "stored")
      throw new MeetingRecorderError(
        404,
        "NOT_FOUND",
        "Stored segment not found.",
      );
    await pluginAudit({
      db: c.get("db"),
      action: "meeting_recorder.transcription.requested",
      resourceType: "meeting_recorder.recording",
      resourceId: recording.id,
      userId: context.userId,
      requestId: context.requestId,
      logicalKey: `${recording.id}:${sequence}:${segment.checksumSha256}`,
      metadata: { sequence },
    });
    await transcribeStoredSegment({
      env: c.env,
      db: c.get("db"),
      recording,
      segment,
      actorUserId: context.userId,
      requestId: context.requestId,
    });
    return c.json({
      segment: await repository(c).segment(recording.id, sequence),
    });
  },
);

app.get("/recordings/:recordingId/transcript", async (c) => {
  const recording = await recordingFor(
    c,
    "meeting_recorder.recording.read",
    "meeting_recorder.recording.read_all",
  );
  const transcript = await repository(c).transcript(recording.id);
  const accept = c.req.header("Accept") ?? "application/json";
  if (accept.includes("text/vtt"))
    return c.text(transcript.vtt, 200, {
      "Content-Type": "text/vtt; charset=utf-8",
    });
  if (accept.includes("text/plain"))
    return c.text(transcript.text, 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  return c.json(transcript);
});

const subjectHash = async (userId: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`meeting-recorder:${userId}`),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

app.delete("/recordings/:recordingId", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.delete");
  const id = c.req.param("recordingId");
  const recording = await repository(c).recording(id);
  if (!recording) {
    const hash = await subjectHash(context.userId);
    const tombstone = await c
      .get("db")
      .first<{ ownerHash: string; requesterHash: string }>(
        `SELECT owner_subject_hash AS "ownerHash", requester_subject_hash AS "requesterHash"
         FROM meeting_recorder_deletion_tombstones WHERE recording_id = ? AND expires_at > ?`,
        [id, repositoryTime(c.get("db"))],
      );
    if (
      tombstone &&
      (tombstone.ownerHash === hash || tombstone.requesterHash === hash)
    )
      return c.body(null, 204);
    throw new MeetingRecorderError(404, "NOT_FOUND", "Recording not found.");
  }
  requireRecordingAccess(
    context,
    recording,
    "meeting_recorder.recording.delete",
    "meeting_recorder.recording.manage_all",
  );
  const operationId =
    recording.deletionOperationId ??
    `del_${crypto.randomUUID().replaceAll("-", "")}`;
  await c.get("db").execute(
    `UPDATE meeting_recorder_recordings SET capture_status = 'deleting',
       deletion_operation_id = ?, deletion_requested_by_user_id = ?, updated_at = ?
     WHERE id = ?`,
    [operationId, context.userId, repositoryTime(c.get("db")), recording.id],
  );
  return c.json(
    { operationId, deletedSegments: recording.deletedSegmentCount },
    202,
  );
});

app.post("/recordings/:recordingId/deletion-steps", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.delete");
  mutablePostKey(c);
  const recording = requireRecordingAccess(
    context,
    await repository(c).recording(c.req.param("recordingId")),
    "meeting_recorder.recording.delete",
    "meeting_recorder.recording.manage_all",
  );
  if (recording.captureStatus !== "deleting" || !recording.deletionOperationId)
    throw new MeetingRecorderError(
      409,
      "INVALID_CAPTURE_STATE",
      "Deletion has not been started.",
    );
  const segments = await c.get("db").query<{
    id: string;
    r2Key: string;
    storageStatus: string;
  }>(
    `SELECT id, r2_key AS "r2Key", storage_status AS "storageStatus"
       FROM meeting_recorder_segments
      WHERE recording_id = ? ORDER BY sequence LIMIT 500`,
    [recording.id],
  );
  if (segments.length) {
    const storedKeys = segments
      .filter((segment) => segment.storageStatus === "stored")
      .map((segment) => segment.r2Key);
    if (storedKeys.length) await requireStorage(c.env).delete(storedKeys);
    const placeholders = segments.map(() => "?").join(",");
    await c.get("db").atomic([
      {
        sql: `DELETE FROM meeting_recorder_segments WHERE recording_id = ? AND id IN (${placeholders})`,
        params: [recording.id, ...segments.map((segment) => segment.id)],
      },
      {
        sql: `UPDATE meeting_recorder_recordings SET deleted_segment_count = deleted_segment_count + ?, updated_at = ? WHERE id = ?`,
        params: [segments.length, repositoryTime(c.get("db")), recording.id],
      },
    ]);
    return c.json(
      {
        operationId: recording.deletionOperationId,
        deletedSegments: recording.deletedSegmentCount + segments.length,
        complete: false,
      },
      202,
    );
  }
  const completedAt = Date.now();
  const ownerHash = await subjectHash(recording.ownerUserId);
  const requesterHash = await subjectHash(context.userId);
  const insertTombstone =
    c.get("db").provider === "d1"
      ? `INSERT OR REPLACE INTO meeting_recorder_deletion_tombstones(
           recording_id,owner_subject_hash,requester_subject_hash,deletion_operation_id,completed_at,expires_at
         ) VALUES (?,?,?,?,?,?)`
      : `INSERT INTO meeting_recorder_deletion_tombstones(
           recording_id,owner_subject_hash,requester_subject_hash,deletion_operation_id,completed_at,expires_at
         ) VALUES (?,?,?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET
           requester_subject_hash=excluded.requester_subject_hash,
           deletion_operation_id=excluded.deletion_operation_id,
           completed_at=excluded.completed_at,expires_at=excluded.expires_at`;
  await c.get("db").atomic([
    {
      sql: insertTombstone,
      params: [
        recording.id,
        ownerHash,
        requesterHash,
        recording.deletionOperationId,
        repositoryTime(c.get("db"), completedAt),
        repositoryTime(c.get("db"), completedAt + 30 * 86_400_000),
      ],
    },
    {
      sql: "DELETE FROM meeting_recorder_recordings WHERE id = ? AND capture_status = 'deleting'",
      params: [recording.id],
    },
  ]);
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.recording.deleted",
    resourceType: "meeting_recorder.recording",
    resourceId: recording.id,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: recording.deletionOperationId,
    metadata: { deletedSegments: recording.deletedSegmentCount },
  });
  return c.body(null, 204);
});

app.get("/settings", async (c) => {
  const context = userContext(c);
  if (
    ![
      "meeting_recorder.settings.read",
      "meeting_recorder.telegram_member.read",
      "meeting_recorder.telegram_member.invite",
      "meeting_recorder.telegram_member.delete",
      "meeting_recorder.telegram_member.read_all",
      "meeting_recorder.telegram_member.manage_all",
    ].some((permission) => context.permissions.includes(permission))
  )
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  const telegramConfiguration = await repository(c).telegramConfiguration();
  const telegramSecretsConfigured = Boolean(
    c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_WEBHOOK_SECRET,
  );
  const userLink = await telegramUserLink(c.get("db"), context.userId);
  return c.json({
    settings: await repository(c).settings(),
    capabilities: {
      storageEnabled: Boolean(c.env.STORAGE),
      telegramTransientMode: !c.env.STORAGE,
    },
    telegram: {
      botTokenConfigured: Boolean(c.env.TELEGRAM_BOT_TOKEN),
      webhookSecretConfigured: Boolean(c.env.TELEGRAM_WEBHOOK_SECRET),
      configured: telegramSecretsConfigured && Boolean(telegramConfiguration),
      bot:
        telegramSecretsConfigured && telegramConfiguration
          ? {
              id: telegramConfiguration.botId,
              username: telegramConfiguration.username,
              name: telegramConfiguration.displayName,
              link: `https://t.me/${telegramConfiguration.username}`,
            }
          : null,
      webhook:
        telegramSecretsConfigured && telegramConfiguration
          ? {
              url: telegramConfiguration.webhookUrl,
              verifiedAt: telegramConfiguration.verifiedAt,
            }
          : null,
      userLink,
    },
  });
});

app.get("/defaults", async (c) => {
  requirePermission(c, "meeting_recorder.recording.create");
  const settings = await repository(c).settings();
  return c.json({
    defaultLanguage: settings.defaultLanguage,
    autoTranscribe: settings.autoTranscribe,
    maximumMinutes: settings.maximumMinutes,
    storageEnabled: Boolean(c.env.STORAGE),
  });
});

app.put("/settings", async (c) => {
  const context = requirePermission(c, "meeting_recorder.settings.update");
  const input = settingsInput.parse(await c.req.json());
  const settings = await repository(c).updateSettings({
    ...input,
    userId: context.userId,
  });
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.settings.updated",
    resourceType: "meeting_recorder.settings",
    resourceId: "global",
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `global:${settings.version}`,
    metadata: { version: settings.version },
  });
  return c.json({ settings });
});

app.get("/storage", async (c) => {
  requirePermission(c, "meeting_recorder.storage.read");
  return c.json(await repository(c).storageTotals());
});

app.post("/telegram/validate", async (c) => {
  requirePermission(c, "meeting_recorder.settings.update");
  mutablePostKey(c);
  const input = z
    .object({ token: z.string().trim().min(20).max(2_048) })
    .parse(await c.req.json());
  const bot = await validateTelegramBot(input.token);
  return c.json({
    bot: {
      id: String(bot.id),
      username: bot.username!,
      name: bot.first_name,
      link: `https://t.me/${bot.username}`,
    },
  });
});

app.post("/telegram/configure", async (c) => {
  const context = requirePermission(c, "meeting_recorder.settings.update");
  mutablePostKey(c);
  if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_WEBHOOK_SECRET)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Configure both Telegram Worker secrets before enabling the webhook.",
    );
  const input = z.object({ webhookUrl: z.url() }).parse(await c.req.json());
  const canonicalWebhookUrl = new URL(
    "/api/v1/public/p/meeting_recorder/telegram/webhook",
    `${context.origin}/`,
  ).toString();
  if (new URL(input.webhookUrl).toString() !== canonicalWebhookUrl)
    throw new MeetingRecorderError(
      422,
      "TELEGRAM_WEBHOOK_URL_INVALID",
      "The Telegram webhook must use this Nexus installation's canonical endpoint.",
    );
  const configured = await configureTelegramWebhook({
    token: c.env.TELEGRAM_BOT_TOKEN,
    secret: c.env.TELEGRAM_WEBHOOK_SECRET,
    webhookUrl: canonicalWebhookUrl,
  });
  await repository(c).saveTelegramConfiguration({
    botId: String(configured.bot.id),
    username: configured.bot.username!,
    displayName: configured.bot.first_name,
    webhookUrl: configured.webhook.url,
    userId: context.userId,
  });
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.settings.updated",
    resourceType: "meeting_recorder.telegram",
    resourceId: "webhook",
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `telegram:${Date.now()}`,
    metadata: {
      configured: true,
      botId: String(configured.bot.id),
      webhookChanged: configured.webhookChanged,
    },
  });
  return c.json({
    configured: true,
    webhookChanged: configured.webhookChanged,
    bot: {
      id: String(configured.bot.id),
      username: configured.bot.username!,
      name: configured.bot.first_name,
      link: `https://t.me/${configured.bot.username}`,
    },
    webhook: {
      url: configured.webhook.url,
      verified: true,
    },
  });
});

app.post("/telegram/link-requests", async (c) => {
  const context = requirePermission(c, "meeting_recorder.recording.create");
  mutablePostKey(c);
  if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_WEBHOOK_SECRET)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Configure the Telegram bot before linking a user.",
    );
  const configuration = await repository(c).telegramConfiguration();
  if (!configuration)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Verify the Telegram webhook before linking a user.",
    );
  const link = await createTelegramLinkRequest({
    db: c.get("db"),
    userId: context.userId,
    botUsername: configuration.username,
  });
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.telegram.link_requested",
    resourceType: "meeting_recorder.telegram_user_link",
    resourceId: context.userId,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `telegram-link:${context.userId}:${link.expiresAt}`,
    metadata: { expiresAt: link.expiresAt },
  });
  return c.json(link, 201);
});

app.get("/telegram/access", async (c) => {
  const context = userContext(c);
  const readAll = [
    "meeting_recorder.telegram_member.read_all",
    "meeting_recorder.telegram_member.manage_all",
  ].some((permission) => context.permissions.includes(permission));
  if (
    !readAll &&
    !context.permissions.includes("meeting_recorder.telegram_member.read")
  )
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  return c.json({
    items: await listTelegramAccess({
      db: c.get("db"),
      viewerUserId: context.userId,
      readAll,
    }),
  });
});

app.post("/telegram/invitations", async (c) => {
  const context = requirePermission(
    c,
    "meeting_recorder.telegram_member.invite",
  );
  if (!context.permissions.includes("meeting_recorder.recording.create"))
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  mutablePostKey(c);
  if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_WEBHOOK_SECRET)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Configure the Telegram bot before inviting a person.",
    );
  const configuration = await repository(c).telegramConfiguration();
  if (!configuration)
    throw new MeetingRecorderError(
      503,
      "TELEGRAM_NOT_CONFIGURED",
      "Verify the Telegram webhook before inviting a person.",
    );
  const input = telegramInvitationInput.parse(await c.req.json());
  const invitation = await createTelegramInvitation({
    db: c.get("db"),
    ownerUserId: context.userId,
    createdByUserId: context.userId,
    botUsername: configuration.username,
    label: input.label,
  });
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.telegram.invitation_created",
    resourceType: "meeting_recorder.telegram_invitation",
    resourceId: invitation.id,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `telegram-invitation:${invitation.id}`,
    metadata: { expiresAt: invitation.expiresAt },
  });
  return c.json(invitation, 201);
});

app.delete("/telegram/members/:memberId", async (c) => {
  const context = userContext(c);
  const manageAll = context.permissions.includes(
    "meeting_recorder.telegram_member.manage_all",
  );
  if (
    !manageAll &&
    !context.permissions.includes("meeting_recorder.telegram_member.delete")
  )
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  mutablePostKey(c);
  const memberId = telegramAccessId.parse(c.req.param("memberId"));
  const revoked = await revokeTelegramMember({
    db: c.get("db"),
    id: memberId,
    viewerUserId: context.userId,
    manageAll,
  });
  if (!revoked)
    throw new MeetingRecorderError(404, "NOT_FOUND", "Member not found.");
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.telegram.member_revoked",
    resourceType: "meeting_recorder.telegram_member",
    resourceId: memberId,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `telegram-member-revoked:${memberId}`,
  });
  return c.body(null, 204);
});

app.delete("/telegram/invitations/:invitationId", async (c) => {
  const context = userContext(c);
  const manageAll = context.permissions.includes(
    "meeting_recorder.telegram_member.manage_all",
  );
  if (
    !manageAll &&
    !context.permissions.includes("meeting_recorder.telegram_member.delete")
  )
    throw new MeetingRecorderError(403, "FORBIDDEN", "Permission denied.");
  mutablePostKey(c);
  const invitationId = telegramAccessId.parse(c.req.param("invitationId"));
  const revoked = await revokeTelegramInvitation({
    db: c.get("db"),
    id: invitationId,
    viewerUserId: context.userId,
    manageAll,
  });
  if (!revoked)
    throw new MeetingRecorderError(404, "NOT_FOUND", "Invitation not found.");
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.telegram.invitation_revoked",
    resourceType: "meeting_recorder.telegram_invitation",
    resourceId: invitationId,
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `telegram-invitation-revoked:${invitationId}`,
  });
  return c.body(null, 204);
});

app.delete("/telegram/configuration", async (c) => {
  const context = requirePermission(c, "meeting_recorder.settings.update");
  mutablePostKey(c);
  if (c.env.TELEGRAM_BOT_TOKEN)
    await deleteTelegramWebhook(c.env.TELEGRAM_BOT_TOKEN);
  await repository(c).clearTelegramConfiguration();
  await pluginAudit({
    db: c.get("db"),
    action: "meeting_recorder.settings.updated",
    resourceType: "meeting_recorder.telegram",
    resourceId: "webhook",
    userId: context.userId,
    requestId: context.requestId,
    logicalKey: `telegram-disconnect:${Date.now()}`,
    metadata: { configured: false },
  });
  return c.body(null, 204);
});

const deterministicTelegramRecordingId = async (
  updateId: number,
): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`telegram:${updateId}`),
    ),
  );
  return `mrr_tg_${[...digest]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

const notifyTelegram = async (
  token: string | undefined,
  chatId: number | undefined,
  message: string,
): Promise<void> => {
  if (!token || !Number.isSafeInteger(chatId)) return;
  try {
    await sendTelegramMessage(token, chatId!, message);
  } catch {
    // Telegram delivery feedback must never make the webhook retry an update
    // whose database work has already completed.
  }
};

const telegramRecordingUrl = (
  webhookUrl: string | undefined,
  recordingId: string,
): string | null => {
  if (!webhookUrl) return null;
  try {
    return new URL(
      `/app/meeting-recorder/${encodeURIComponent(recordingId)}`,
      webhookUrl,
    ).toString();
  } catch {
    return null;
  }
};

const telegramMessageWithLink = (
  message: string,
  recordingUrl: string | null,
): string => (recordingUrl ? `${message}\n${recordingUrl}` : message);

app.post("/public/telegram/webhook", async (c) => {
  if (!c.get("publicContext"))
    throw new MeetingRecorderError(
      403,
      "FORBIDDEN",
      "Public plugin context required.",
    );
  if (
    !telegramSecretMatches(
      c.env.TELEGRAM_WEBHOOK_SECRET,
      c.req.header("X-Telegram-Bot-Api-Secret-Token"),
    )
  )
    throw new MeetingRecorderError(
      401,
      "TELEGRAM_WEBHOOK_UNAUTHORIZED",
      "Invalid Telegram webhook secret.",
    );
  const length = Number(c.req.header("Content-Length") ?? 0);
  if (length > 1024 * 1024)
    throw new MeetingRecorderError(
      413,
      "TELEGRAM_UPDATE_TOO_LARGE",
      "Telegram update is too large.",
    );
  const update = (await c.req.json()) as TelegramUpdate;
  if (!Number.isSafeInteger(update.update_id))
    throw new MeetingRecorderError(
      422,
      "TELEGRAM_UPDATE_INVALID",
      "Telegram update is invalid.",
    );
  const message = update.message;
  const startCommand = Boolean(
    message?.text?.trim().match(/^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s|$)/u),
  );
  if (startCommand && message?.from) {
    const start = telegramStartPayload(message.text);
    const privateChat = message.chat.id === message.from.id;
    const linked =
      start && privateChat
        ? start.kind === "invitation"
          ? await consumeTelegramInvitation({
              db: c.get("db"),
              token: start.token,
              telegramId: String(message.from.id),
              ...(message.from.username
                ? { telegramUsername: message.from.username }
                : {}),
              ...(message.from.first_name
                ? { firstName: message.from.first_name }
                : {}),
              ...(message.from.last_name
                ? { lastName: message.from.last_name }
                : {}),
            })
          : await consumeTelegramLinkRequest({
              db: c.get("db"),
              token: start.token,
              telegramId: String(message.from.id),
              ...(message.from.username
                ? { telegramUsername: message.from.username }
                : {}),
            })
        : null;
    if (linked) {
      await pluginAudit({
        db: c.get("db"),
        action:
          linked.kind === "invitation"
            ? "meeting_recorder.telegram.invitation_accepted"
            : "meeting_recorder.telegram.user_linked",
        resourceType:
          linked.kind === "invitation"
            ? "meeting_recorder.telegram_member"
            : "meeting_recorder.telegram_user_link",
        resourceId:
          linked.kind === "invitation" ? linked.memberId : linked.userId,
        userId: linked.userId,
        requestId: requestId(c),
        logicalKey:
          linked.kind === "invitation"
            ? `telegram-member:${linked.memberId}`
            : `telegram-user:${message.from.id}`,
        metadata: {
          linked: true,
          invited: linked.kind === "invitation",
        },
      });
      await notifyTelegram(
        c.env.TELEGRAM_BOT_TOKEN,
        message.chat.id,
        linked.kind === "invitation"
          ? `Convite aceito. Seus áudios serão transcritos e enviados para ${linked.ownerName} no Nexus. Agora envie um áudio ou uma mensagem de voz.`
          : "Conta vinculada com sucesso. Agora envie um áudio ou uma mensagem de voz para transcrever.",
      );
      return c.json({ ok: true, linked: true });
    }
    await notifyTelegram(
      c.env.TELEGRAM_BOT_TOKEN,
      message.chat.id,
      privateChat
        ? start?.kind === "invitation"
          ? "Este convite expirou, foi cancelado, já foi usado ou este Telegram já possui acesso. Peça um novo convite."
          : "Este link expirou ou já foi usado. Gere um novo link nas configurações do Gravador de reuniões."
        : "Abra este bot em uma conversa privada para vincular sua conta.",
    );
    return c.json({ ok: true, linked: false });
  }
  const externalEventId = String(update.update_id);
  const recordingId = await deterministicTelegramRecordingId(update.update_id);
  const existing = await c.get("db").first<{
    status: string;
    updatedAt: unknown;
  }>(
    `SELECT status, updated_at AS "updatedAt" FROM meeting_recorder_ingest_events
      WHERE source = 'telegram' AND external_event_id = ?`,
    [externalEventId],
  );
  const media = message?.voice ?? message?.audio;
  const ownerId = message?.from
    ? await telegramOwner(c, String(message.from.id))
    : null;
  const telegramConfiguration = await repository(c).telegramConfiguration();
  const now = repositoryTime(c.get("db"));
  let eventReserved = false;
  if (existing) {
    const updatedAt =
      existing.updatedAt instanceof Date
        ? existing.updatedAt.getTime()
        : new Date(existing.updatedAt as string | number).getTime();
    const retryable =
      existing.status === "failed" ||
      (existing.status === "processing" && Date.now() - updatedAt > 60_000);
    if (!retryable) return c.json({ ok: true, replay: true });
    const priorUpdatedAt =
      existing.updatedAt instanceof Date ||
      typeof existing.updatedAt === "string"
        ? existing.updatedAt
        : Number(existing.updatedAt);
    const claimed = await c.get("db").execute(
      `UPDATE meeting_recorder_ingest_events
          SET status = 'processing', error_code = NULL, updated_at = ?
        WHERE source = 'telegram' AND external_event_id = ?
          AND status = ? AND updated_at = ?`,
      [now, externalEventId, existing.status, priorUpdatedAt],
    );
    if (!claimed.rowsAffected) return c.json({ ok: true, replay: true });
    eventReserved = true;
  }
  const insertEvent =
    c.get("db").provider === "d1"
      ? `INSERT OR IGNORE INTO meeting_recorder_ingest_events(
           source,external_event_id,recording_id,owner_user_id,status,created_at,updated_at
         ) VALUES ('telegram',?,?,?,'processing',?,?)`
      : `INSERT INTO meeting_recorder_ingest_events(
           source,external_event_id,recording_id,owner_user_id,status,created_at,updated_at
         ) VALUES ('telegram',?,?,?,'processing',?,?) ON CONFLICT(source,external_event_id) DO NOTHING`;
  if (!eventReserved) {
    const reserved = await c
      .get("db")
      .execute(insertEvent, [externalEventId, recordingId, ownerId, now, now]);
    if (!reserved.rowsAffected) return c.json({ ok: true, replay: true });
  }
  if (!message || !media || !ownerId || !c.env.TELEGRAM_BOT_TOKEN) {
    const ignoreCode = !ownerId
      ? "TELEGRAM_USER_NOT_LINKED"
      : !media
        ? "TELEGRAM_AUDIO_REQUIRED"
        : "TELEGRAM_NOT_CONFIGURED";
    await c.get("db").execute(
      `UPDATE meeting_recorder_ingest_events SET status = 'ignored',
         error_code = ?, updated_at = ? WHERE source = 'telegram' AND external_event_id = ?`,
      [ignoreCode, repositoryTime(c.get("db")), externalEventId],
    );
    await notifyTelegram(
      c.env.TELEGRAM_BOT_TOKEN,
      message?.chat.id,
      !ownerId
        ? "Este Telegram não está autorizado. Vincule sua conta nas configurações do Gravador de reuniões ou peça um novo convite à pessoa responsável."
        : !media
          ? "Envie uma mensagem de voz ou um arquivo de áudio para transcrever."
          : "O bot ainda não está completamente configurado no Nexus.",
    );
    return c.json({ ok: true, ignored: true });
  }
  await notifyTelegram(
    c.env.TELEGRAM_BOT_TOKEN,
    message.chat.id,
    existing
      ? "Áudio recebido novamente. Retomando o processamento."
      : "Áudio recebido.",
  );
  let recordingUrl: string | null = null;
  let audioRetained = false;
  let failureStage = "validating_media";
  try {
    if ((media.file_size ?? 0) > IMPORT_MAX_BYTES)
      throw new MeetingRecorderError(
        413,
        "AUDIO_IMPORT_TOO_LARGE",
        "Telegram audio exceeds 20 MiB.",
      );
    failureStage = "downloading_audio";
    const file = await downloadTelegramMedia(c.env.TELEGRAM_BOT_TOKEN, media);
    failureStage = "validating_audio";
    extensionForMime(file.mimeType);
    const settings = await repository(c).settings();
    const storage = c.env.STORAGE ? await repository(c).storageTotals() : null;
    if (
      Math.max(1_000, media.duration * 1_000) >
      settings.maximumMinutes * 60_000
    )
      throw new MeetingRecorderError(
        422,
        "RECORDING_DURATION_LIMIT",
        "The Telegram audio exceeds the configured duration limit.",
      );
    if (
      storage &&
      storage.totalBytes + file.bytes.byteLength > settings.storageLimitBytes
    )
      throw new MeetingRecorderError(
        413,
        "STORAGE_LIMIT_EXCEEDED",
        "The configured recording storage limit has been reached.",
      );
    const title =
      message.caption?.trim().slice(0, 200) ||
      media.title?.trim().slice(0, 200) ||
      file.fileName?.slice(0, 200) ||
      `Telegram ${new Date(message.date * 1_000).toISOString().slice(0, 16).replace("T", " ")}`;
    failureStage = "creating_recording";
    const recording = await repository(c).create({
      id: recordingId,
      clientSessionId: `telegram-${update.update_id}`,
      ownerUserId: ownerId,
      title,
      ingestSource: "telegram",
      externalSourceId: media.file_unique_id,
      ...(file.fileName ? { originalFileName: file.fileName } : {}),
      sourceType: message.voice ? "telegram_voice" : "telegram_audio",
      language: settings.defaultLanguage as "pt-BR" | "en" | "auto",
      mimeType: file.mimeType,
      segmentDurationMs: Math.max(1_000, media.duration * 1_000),
      // When R2 is disabled, transcription is mandatory because the source
      // bytes are intentionally discarded after this webhook request.
      autoTranscribe: c.env.STORAGE ? settings.autoTranscribe : true,
      consentVersion: CONSENT_VERSION,
      captureStatus: "finalizing",
      startedAt: message.date * 1_000,
    });
    recordingUrl = telegramRecordingUrl(
      telegramConfiguration?.webhookUrl,
      recording.id,
    );
    const durationMs = Math.max(1_000, media.duration * 1_000);
    let complete: Recording;
    let segment: Segment;
    if (c.env.STORAGE) {
      failureStage = "storing_audio";
      const key = segmentObjectKey(recording.id, 0, file.mimeType);
      const stored = await putAudioBuffer({
        storage: c.env.STORAGE,
        key,
        bytes: file.bytes,
        mimeType: file.mimeType,
        metadata: {
          recordingId: recording.id,
          sequence: "0",
          durationMs: String(durationMs),
          source: "telegram",
        },
      });
      const reserved = await repository(c).reserveSegment({
        recordingId: recording.id,
        sequence: 0,
        startOffsetMs: 0,
        durationMs,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.byteLength,
        checksum: stored.checksumBase64,
        r2Key: key,
      });
      segment = reserved.segment;
      await repository(c).markStored(segment, stored.object);
      audioRetained = true;
      complete = await repository(c).finalize(recording.id, 0, []);
      await c.get("db").execute(
        `UPDATE meeting_recorder_ingest_events SET status = 'stored', updated_at = ?
          WHERE source = 'telegram' AND external_event_id = ?`,
        [repositoryTime(c.get("db")), externalEventId],
      );
    } else {
      failureStage = "preparing_transcription";
      const checksum = await base64Sha256(file.bytes);
      const reserved = await repository(c).reserveTransientSegment({
        recordingId: recording.id,
        sequence: 0,
        startOffsetMs: 0,
        durationMs,
        mimeType: file.mimeType,
        sizeBytes: file.bytes.byteLength,
        checksum,
        transientKey: `transient/telegram/${recording.id}/0`,
      });
      segment = reserved.segment;
      if (
        !segmentMatches(segment, {
          checksum,
          sizeBytes: file.bytes.byteLength,
          durationMs,
          startOffsetMs: 0,
          mimeType: file.mimeType,
        })
      )
        throw new MeetingRecorderError(
          409,
          "SEGMENT_CONFLICT",
          "This Telegram event already references different audio.",
        );
      complete = await repository(c).finalize(recording.id, 0, []);
    }
    await pluginAudit({
      db: c.get("db"),
      action: "meeting_recorder.recording.created",
      resourceType: "meeting_recorder.recording",
      resourceId: recording.id,
      userId: ownerId,
      requestId: requestId(c),
      logicalKey: `telegram:${externalEventId}`,
      metadata: {
        ingestSource: "telegram",
        audioRetained: Boolean(c.env.STORAGE),
      },
    });

    if (!c.env.STORAGE) {
      if (segment.transcriptionStatus !== "ready") {
        await notifyTelegram(
          c.env.TELEGRAM_BOT_TOKEN,
          message.chat.id,
          "Iniciando transcrição.",
        );
        failureStage = "transcribing_audio";
        await transcribeTransientSegment({
          env: c.env,
          db: c.get("db"),
          recording: complete,
          segment,
          bytes: file.bytes,
          actorUserId: ownerId,
          requestId: requestId(c),
        });
      }
      await c.get("db").execute(
        `UPDATE meeting_recorder_ingest_events
            SET status = 'transcribed', error_code = NULL, updated_at = ?
          WHERE source = 'telegram' AND external_event_id = ?`,
        [repositoryTime(c.get("db")), externalEventId],
      );
      await notifyTelegram(
        c.env.TELEGRAM_BOT_TOKEN,
        message.chat.id,
        telegramMessageWithLink(
          "Transcrição pronta. Como o R2 está desativado, o áudio não foi armazenado.",
          recordingUrl,
        ),
      );
      return c.json({
        ok: true,
        recordingId: recording.id,
        audioRetained: false,
      });
    }

    if (!settings.autoTranscribe) {
      await notifyTelegram(
        c.env.TELEGRAM_BOT_TOKEN,
        message.chat.id,
        telegramMessageWithLink(
          "Áudio armazenado. A transcrição automática está desativada.",
          recordingUrl,
        ),
      );
      return c.json({ ok: true, recordingId: recording.id });
    }

    await notifyTelegram(
      c.env.TELEGRAM_BOT_TOKEN,
      message.chat.id,
      "Iniciando transcrição.",
    );

    const task = (async () => {
      const db = await createDatabase(c.env);
      try {
        const repo = new MeetingRecorderRepository(db);
        const freshSegment = await repo.segment(recording.id, 0);
        if (!freshSegment)
          throw new MeetingRecorderError(
            503,
            "TRANSCRIPTION_SEGMENT_MISSING",
            "The stored audio segment is unavailable.",
          );
        await transcribeStoredSegment({
          env: c.env,
          db,
          recording: complete,
          segment: freshSegment,
          actorUserId: ownerId,
          requestId: requestId(c),
        });
        await db.execute(
          `UPDATE meeting_recorder_ingest_events SET status = 'transcribed', error_code = NULL, updated_at = ?
            WHERE source = 'telegram' AND external_event_id = ?`,
          [repositoryTime(db), externalEventId],
        );
        await notifyTelegram(
          c.env.TELEGRAM_BOT_TOKEN,
          message.chat.id,
          telegramMessageWithLink("Transcrição pronta.", recordingUrl),
        );
      } catch (cause) {
        const code =
          cause instanceof MeetingRecorderError
            ? cause.code
            : "TRANSCRIPTION_FAILED";
        await db.execute(
          `UPDATE meeting_recorder_ingest_events SET status = 'stored', error_code = ?, updated_at = ?
            WHERE source = 'telegram' AND external_event_id = ?`,
          [code, repositoryTime(db), externalEventId],
        );
        await notifyTelegram(
          c.env.TELEGRAM_BOT_TOKEN,
          message.chat.id,
          telegramMessageWithLink(
            `Não foi possível concluir a transcrição (${code}). O áudio continua armazenado e você pode tentar novamente pelo painel.`,
            recordingUrl,
          ),
        );
      } finally {
        await db.close();
      }
    })();
    try {
      c.executionCtx.waitUntil(task);
    } catch {
      await task;
    }
    return c.json({ ok: true, recordingId: recording.id });
  } catch (cause) {
    const code =
      cause instanceof MeetingRecorderError
        ? cause.code
        : `TELEGRAM_${failureStage.toUpperCase()}_FAILED`;
    const permanent =
      cause instanceof MeetingRecorderError &&
      (cause.status === 413 || cause.status === 422);
    await c.get("db").execute(
      `UPDATE meeting_recorder_ingest_events SET status = ?, error_code = ?, updated_at = ?
        WHERE source = 'telegram' AND external_event_id = ?`,
      [
        permanent ? "ignored" : "failed",
        code,
        repositoryTime(c.get("db")),
        externalEventId,
      ],
    );
    if (permanent) {
      await notifyTelegram(
        c.env.TELEGRAM_BOT_TOKEN,
        message?.chat.id,
        telegramMessageWithLink(
          `Não foi possível processar este áudio (${code}). Verifique o formato, o tamanho e a duração e tente novamente.`,
          recordingUrl,
        ),
      );
      return c.json({ ok: true, ignored: true });
    }
    await notifyTelegram(
      c.env.TELEGRAM_BOT_TOKEN,
      message?.chat.id,
      telegramMessageWithLink(
        audioRetained
          ? `O processamento falhou (${code}), mas o áudio continua armazenado. Tente novamente pelo painel.`
          : `O processamento falhou (${code}). O Telegram tentará entregar novamente; se não concluir, envie o áudio mais uma vez.`,
        recordingUrl,
      ),
    );
    throw cause;
  }
});

app.notFound((c) =>
  c.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Resource not found.",
        requestId: requestId(c),
      },
    },
    404,
  ),
);

app.onError((cause, c) => {
  const error =
    cause instanceof MeetingRecorderError
      ? cause
      : cause instanceof ZodError
        ? new MeetingRecorderError(
            422,
            "VALIDATION_ERROR",
            "The request is invalid.",
          )
        : new MeetingRecorderError(
            500,
            "INTERNAL_ERROR",
            "An unexpected error occurred.",
          );
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId: requestId(c),
      },
    },
    error.status,
    { "Cache-Control": "private, no-store" },
  );
});

export default app;
