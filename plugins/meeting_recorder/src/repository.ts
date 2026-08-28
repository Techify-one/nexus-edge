import { createId } from "@app/core-contract";
import type { DatabasePort, SqlValue } from "@app/database";
import { MeetingRecorderError } from "./errors.js";

export type CaptureStatus =
  | "recording"
  | "paused"
  | "interrupted"
  | "finalizing"
  | "complete"
  | "deleting";
export type TranscriptionStatus =
  | "off"
  | "pending"
  | "processing"
  | "ready"
  | "partial"
  | "quota_wait"
  | "failed";

export type Recording = {
  id: string;
  clientSessionId: string;
  ownerUserId: string;
  ownerName: string | null;
  title: string;
  ingestSource: "live" | "upload" | "telegram";
  externalSourceId: string | null;
  originalFileName: string | null;
  meetingPlatform: string | null;
  sourceType: string;
  captureStatus: CaptureStatus;
  effectiveCaptureStatus: CaptureStatus;
  transcriptionStatus: TranscriptionStatus;
  language: "pt-BR" | "en" | "auto";
  mimeType: string;
  bitrateBps: number | null;
  segmentDurationMs: number;
  autoTranscribe: boolean;
  expectedLastSequence: number | null;
  hasGaps: boolean;
  missingSegmentCount: number;
  storedSegmentCount: number;
  transcribedSegmentCount: number;
  totalBytes: number;
  storedDurationMs: number;
  timelineDurationMs: number;
  pausedDurationMs: number;
  gapDurationMs: number;
  startedAt: unknown;
  stoppedAt: unknown | null;
  lastSegmentAt: unknown | null;
  lastHeartbeatAt: unknown | null;
  deletionOperationId: string | null;
  deletedSegmentCount: number;
  version: number;
  createdAt: unknown;
  updatedAt: unknown;
};

export type Segment = {
  id: string;
  recordingId: string;
  sequence: number;
  startOffsetMs: number;
  durationMs: number;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  r2Key: string;
  r2Etag: string | null;
  r2Version: string | null;
  storageStatus: string;
  transcriptionStatus: string;
  transcriptText: string | null;
  transcriptVtt: string | null;
  transcriptionAttempts: number;
  leaseToken: string | null;
  leaseExpiresAt: unknown | null;
};

const time = (db: DatabasePort, value = Date.now()): number | Date =>
  db.provider === "d1" ? value : new Date(value);

const recordingSelect = `SELECT
  r.id, r.client_session_id AS "clientSessionId", r.owner_user_id AS "ownerUserId",
  u.name AS "ownerName", r.title, r.ingest_source AS "ingestSource",
  r.external_source_id AS "externalSourceId", r.original_file_name AS "originalFileName",
  r.meeting_platform AS "meetingPlatform", r.source_type AS "sourceType",
  r.capture_status AS "captureStatus", r.transcription_status AS "transcriptionStatus",
  r.language, r.mime_type AS "mimeType", r.bitrate_bps AS "bitrateBps",
  r.segment_duration_ms AS "segmentDurationMs", r.auto_transcribe AS "autoTranscribe",
  r.expected_last_sequence AS "expectedLastSequence", r.has_gaps AS "hasGaps",
  r.missing_segment_count AS "missingSegmentCount",
  r.stored_segment_count AS "storedSegmentCount",
  r.transcribed_segment_count AS "transcribedSegmentCount",
  r.total_bytes AS "totalBytes", r.stored_duration_ms AS "storedDurationMs",
  r.timeline_duration_ms AS "timelineDurationMs", r.paused_duration_ms AS "pausedDurationMs",
  r.gap_duration_ms AS "gapDurationMs", r.started_at AS "startedAt",
  r.stopped_at AS "stoppedAt", r.last_segment_at AS "lastSegmentAt",
  r.last_heartbeat_at AS "lastHeartbeatAt", r.deletion_operation_id AS "deletionOperationId",
  r.deleted_segment_count AS "deletedSegmentCount", r.version,
  r.created_at AS "createdAt", r.updated_at AS "updatedAt"
  FROM meeting_recorder_recordings r LEFT JOIN "user" u ON u.id = r.owner_user_id`;

const segmentSelect = `SELECT id, recording_id AS "recordingId", sequence,
  start_offset_ms AS "startOffsetMs", duration_ms AS "durationMs", mime_type AS "mimeType",
  size_bytes AS "sizeBytes", checksum_sha256 AS "checksumSha256", r2_key AS "r2Key",
  r2_etag AS "r2Etag", r2_version AS "r2Version", storage_status AS "storageStatus",
  transcription_status AS "transcriptionStatus", transcript_text AS "transcriptText",
  transcript_vtt AS "transcriptVtt", transcription_attempts AS "transcriptionAttempts",
  transcription_lease_token AS "leaseToken", transcription_lease_expires_at AS "leaseExpiresAt"
  FROM meeting_recorder_segments`;

const shiftedVtt = (value: string, offsetMs: number): string => {
  const timestamp = (match: string): string => {
    const parts = match.split(":");
    const secondsPart = parts.pop() ?? "0";
    const hours = parts.length === 2 ? Number(parts.shift()) : 0;
    const minutes = Number(parts.shift() ?? 0);
    const [seconds, milliseconds = "0"] = secondsPart.split(".");
    const total =
      hours * 3_600_000 +
      minutes * 60_000 +
      Number(seconds) * 1_000 +
      Number(milliseconds.padEnd(3, "0").slice(0, 3)) +
      offsetMs;
    const shiftedHours = Math.floor(total / 3_600_000);
    const shiftedMinutes = Math.floor((total % 3_600_000) / 60_000);
    const shiftedSeconds = Math.floor((total % 60_000) / 1_000);
    const shiftedMilliseconds = total % 1_000;
    return `${String(shiftedHours).padStart(2, "0")}:${String(shiftedMinutes).padStart(2, "0")}:${String(shiftedSeconds).padStart(2, "0")}.${String(shiftedMilliseconds).padStart(3, "0")}`;
  };
  return value
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "WEBVTT")
    .join("\n")
    .replace(/(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/gu, timestamp)
    .trim();
};

const normalizeRecording = (
  row: Omit<Recording, "effectiveCaptureStatus">,
): Recording => {
  const heartbeat =
    row.lastHeartbeatAt instanceof Date
      ? row.lastHeartbeatAt.getTime()
      : Number(row.lastHeartbeatAt ?? 0);
  const stale =
    (row.captureStatus === "recording" || row.captureStatus === "paused") &&
    heartbeat > 0 &&
    Date.now() - heartbeat > 90_000;
  return {
    ...row,
    autoTranscribe: Boolean(row.autoTranscribe),
    hasGaps: Boolean(row.hasGaps),
    totalBytes: Number(row.totalBytes),
    storedDurationMs: Number(row.storedDurationMs),
    timelineDurationMs: Number(row.timelineDurationMs),
    pausedDurationMs: Number(row.pausedDurationMs),
    gapDurationMs: Number(row.gapDurationMs),
    effectiveCaptureStatus: stale ? "interrupted" : row.captureStatus,
  };
};

const encodeCursor = (value: unknown, id: string): string => {
  const bytes = new TextEncoder().encode(JSON.stringify([value, id]));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const decodeCursor = (
  cursor: string | undefined,
): [SqlValue, string] | null => {
  if (!cursor) return null;
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    );
    const parsed = JSON.parse(binary) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[1] !== "string"
    )
      throw new Error("invalid cursor");
    if (
      !["string", "number", "boolean"].includes(typeof parsed[0]) &&
      parsed[0] !== null
    )
      throw new Error("invalid cursor value");
    return parsed as [SqlValue, string];
  } catch {
    throw new MeetingRecorderError(
      400,
      "INVALID_CURSOR",
      "The recordings cursor is invalid.",
    );
  }
};

export class MeetingRecorderRepository {
  constructor(readonly db: DatabasePort) {}

  async recording(id: string): Promise<Recording | null> {
    const row = await this.db.first<Omit<Recording, "effectiveCaptureStatus">>(
      `${recordingSelect} WHERE r.id = ?`,
      [id],
    );
    return row ? normalizeRecording(row) : null;
  }

  async list(input: {
    userId: string;
    readAll: boolean;
    search?: string;
    status?: string;
    source?: string;
    owner?: string;
    sort?: string;
    direction?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: Recording[]; nextCursor: string | null }> {
    const sortColumns = new Map<string, string>([
      ["title", "r.title"],
      ["status", "r.capture_status"],
      ["source", "r.ingest_source"],
      ["duration", "r.stored_duration_ms"],
      ["size", "r.total_bytes"],
      ["transcription", "r.transcription_status"],
      ["owner", "COALESCE(u.name, '')"],
      ["started_at", "r.started_at"],
    ]);
    const sortKey = sortColumns.has(input.sort ?? "")
      ? input.sort!
      : "started_at";
    const sortColumn = sortColumns.get(sortKey)!;
    const direction = input.direction === "asc" ? "ASC" : "DESC";
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (!input.readAll) {
      where.push("r.owner_user_id = ?");
      params.push(input.userId);
    } else if (input.owner) {
      where.push("r.owner_user_id = ?");
      params.push(input.owner);
    }
    if (input.search) {
      where.push("LOWER(r.title) LIKE LOWER(?)");
      params.push(`%${input.search.slice(0, 100)}%`);
    }
    if (input.status) {
      if (input.status === "interrupted") {
        where.push(
          `(r.capture_status = 'interrupted' OR
            (r.capture_status IN ('recording','paused') AND r.last_heartbeat_at < ?))`,
        );
        params.push(time(this.db, Date.now() - 90_000));
      } else {
        where.push("r.capture_status = ?");
        params.push(input.status);
        if (input.status === "recording" || input.status === "paused") {
          where.push("r.last_heartbeat_at >= ?");
          params.push(time(this.db, Date.now() - 90_000));
        }
      }
    }
    if (input.source) {
      where.push("r.ingest_source = ?");
      params.push(input.source);
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor) {
      const operator = direction === "ASC" ? ">" : "<";
      where.push(
        `(${sortColumn} ${operator} ? OR (${sortColumn} = ? AND r.id ${operator} ?))`,
      );
      params.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = await this.db.query<
      Omit<Recording, "effectiveCaptureStatus"> & Record<string, unknown>
    >(
      `${recordingSelect}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${sortColumn} ${direction}, r.id ${direction} LIMIT ?`,
      [...params, input.limit + 1],
    );
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map(normalizeRecording);
    const last = items.at(-1);
    const cursorValues: Record<string, unknown> = {
      title: last?.title,
      status: last?.captureStatus,
      source: last?.ingestSource,
      duration: last?.storedDurationMs,
      size: last?.totalBytes,
      transcription: last?.transcriptionStatus,
      owner: last?.ownerName ?? "",
      started_at:
        last?.startedAt instanceof Date
          ? last.startedAt.toISOString()
          : last?.startedAt,
    };
    return {
      items,
      nextCursor:
        hasMore && last ? encodeCursor(cursorValues[sortKey], last.id) : null,
    };
  }

  async overview(userId: string, readAll: boolean) {
    const scope = readAll ? "" : " WHERE owner_user_id = ?";
    const params = [
      time(this.db, Date.now() - 90_000),
      ...(readAll ? [] : [userId]),
    ];
    const row = await this.db.first<Record<string, number | string>>(
      `SELECT COALESCE(SUM(stored_duration_ms),0) AS "durationMs",
              COALESCE(SUM(total_bytes),0) AS "storageBytes",
              COALESCE(SUM(CASE WHEN transcription_status = 'ready' THEN 1 ELSE 0 END),0) AS "transcriptionsReady",
              COALESCE(SUM(CASE WHEN capture_status = 'interrupted' OR
                (capture_status IN ('recording','paused') AND last_heartbeat_at < ?)
                THEN 1 ELSE 0 END),0) AS "interrupted"
         FROM meeting_recorder_recordings${scope}`,
      params,
    );
    return {
      durationMs: Number(row?.durationMs ?? 0),
      storageBytes: Number(row?.storageBytes ?? 0),
      transcriptionsReady: Number(row?.transcriptionsReady ?? 0),
      interrupted: Number(row?.interrupted ?? 0),
    };
  }

  async create(input: {
    id?: string;
    clientSessionId: string;
    ownerUserId: string;
    title: string;
    ingestSource: "live" | "upload" | "telegram";
    externalSourceId?: string;
    originalFileName?: string;
    meetingPlatform?: string;
    sourceType: string;
    language: "pt-BR" | "en" | "auto";
    mimeType: string;
    bitrateBps?: number;
    segmentDurationMs: number;
    autoTranscribe: boolean;
    consentVersion: string;
    captureStatus?: CaptureStatus;
    startedAt?: number;
  }): Promise<Recording> {
    const id = input.id ?? createId("mrr");
    const now = time(this.db, input.startedAt ?? Date.now());
    const transcriptionStatus = input.autoTranscribe ? "pending" : "off";
    try {
      await this.db.execute(
        `INSERT INTO meeting_recorder_recordings(
          id, client_session_id, owner_user_id, title, ingest_source,
          external_source_id, original_file_name, meeting_platform, source_type,
          capture_status, transcription_status, language, mime_type, bitrate_bps,
          segment_duration_ms, auto_transcribe, consent_version,
          consent_acknowledged_at, started_at, last_heartbeat_at, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          input.clientSessionId,
          input.ownerUserId,
          input.title.trim().slice(0, 200),
          input.ingestSource,
          input.externalSourceId ?? null,
          input.originalFileName?.slice(0, 255) ?? null,
          input.meetingPlatform ?? null,
          input.sourceType,
          input.captureStatus ??
            (input.ingestSource === "live" ? "recording" : "finalizing"),
          transcriptionStatus,
          input.language,
          input.mimeType,
          input.bitrateBps ?? null,
          input.segmentDurationMs,
          input.autoTranscribe,
          input.consentVersion,
          now,
          now,
          now,
          now,
          now,
        ],
      );
    } catch (cause) {
      const existing = await this.db.first<{ id: string }>(
        `SELECT id FROM meeting_recorder_recordings
          WHERE owner_user_id = ? AND client_session_id = ?`,
        [input.ownerUserId, input.clientSessionId],
      );
      if (existing) return (await this.recording(existing.id))!;
      if (
        /unique|constraint/iu.test(
          cause instanceof Error ? cause.message : String(cause),
        )
      )
        throw new MeetingRecorderError(
          409,
          "ACTIVE_RECORDING_EXISTS",
          "This user already has an active recording.",
        );
      throw cause;
    }
    return (await this.recording(id))!;
  }

  async updateTitle(
    id: string,
    title: string,
    version: number,
  ): Promise<Recording | null> {
    const changed = await this.db.execute(
      `UPDATE meeting_recorder_recordings SET title = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND capture_status <> 'deleting'`,
      [title.trim().slice(0, 200), time(this.db), id, version],
    );
    return changed.rowsAffected ? this.recording(id) : null;
  }

  async heartbeat(id: string): Promise<void> {
    await this.db.execute(
      `UPDATE meeting_recorder_recordings SET last_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND capture_status IN ('recording','paused')`,
      [time(this.db), time(this.db), id],
    );
  }

  async setCaptureStatus(id: string, status: CaptureStatus): Promise<void> {
    await this.db.execute(
      `UPDATE meeting_recorder_recordings SET capture_status = ?, last_heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND capture_status <> 'complete' AND capture_status <> 'deleting'`,
      [status, time(this.db), time(this.db), id],
    );
  }

  async segment(
    recordingId: string,
    sequence: number,
  ): Promise<Segment | null> {
    return this.db.first<Segment>(
      `${segmentSelect} WHERE recording_id = ? AND sequence = ?`,
      [recordingId, sequence],
    );
  }

  async reserveSegment(input: {
    recordingId: string;
    sequence: number;
    startOffsetMs: number;
    durationMs: number;
    mimeType: string;
    sizeBytes: number;
    checksum: string;
    r2Key: string;
  }): Promise<{ segment: Segment; created: boolean }> {
    const id = createId("mrs");
    const insert =
      this.db.provider === "d1"
        ? `INSERT OR IGNORE INTO meeting_recorder_segments(
             id, recording_id, sequence, start_offset_ms, duration_ms, mime_type,
             size_bytes, checksum_sha256, r2_key, storage_status, transcription_status,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,'uploading','pending',?,?)`
        : `INSERT INTO meeting_recorder_segments(
             id, recording_id, sequence, start_offset_ms, duration_ms, mime_type,
             size_bytes, checksum_sha256, r2_key, storage_status, transcription_status,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,'uploading','pending',?,?)
           ON CONFLICT (recording_id, sequence) DO NOTHING`;
    const now = time(this.db);
    const result = await this.db.execute(insert, [
      id,
      input.recordingId,
      input.sequence,
      input.startOffsetMs,
      input.durationMs,
      input.mimeType,
      input.sizeBytes,
      input.checksum,
      input.r2Key,
      now,
      now,
    ]);
    const segment = await this.segment(input.recordingId, input.sequence);
    if (!segment) throw new Error("SEGMENT_RESERVATION_FAILED");
    return { segment, created: Boolean(result.rowsAffected) };
  }

  async markStored(segment: Segment, object: R2Object): Promise<void> {
    const storedAt = time(this.db);
    await this.db.atomic([
      {
        sql: `UPDATE meeting_recorder_recordings SET
                 stored_segment_count = stored_segment_count + 1,
                 total_bytes = total_bytes + ?,
                 stored_duration_ms = stored_duration_ms + ?,
                 timeline_duration_ms = CASE WHEN timeline_duration_ms < ? THEN ? ELSE timeline_duration_ms END,
                 last_segment_at = ?, updated_at = ?
               WHERE id = ? AND EXISTS (
                 SELECT 1 FROM meeting_recorder_segments
                  WHERE id = ? AND storage_status <> 'stored'
               )`,
        params: [
          segment.sizeBytes,
          segment.durationMs,
          segment.startOffsetMs + segment.durationMs,
          segment.startOffsetMs + segment.durationMs,
          storedAt,
          storedAt,
          segment.recordingId,
          segment.id,
        ],
      },
      {
        sql: `UPDATE meeting_recorder_segments
                 SET storage_status = 'stored', r2_etag = ?, r2_version = ?,
                     stored_at = ?, updated_at = ?
               WHERE id = ? AND storage_status <> 'stored'`,
        params: [object.etag, object.version, storedAt, storedAt, segment.id],
      },
    ]);
  }

  async segments(recordingId: string): Promise<Segment[]> {
    return this.db.query<Segment>(
      `${segmentSelect} WHERE recording_id = ? ORDER BY sequence`,
      [recordingId],
    );
  }

  async finalize(
    recordingId: string,
    expectedLastSequence: number,
    missingSequences: number[],
  ): Promise<Recording> {
    const stoppedAt = time(this.db);
    await this.db.execute(
      `UPDATE meeting_recorder_recordings SET capture_status = 'complete',
         expected_last_sequence = ?, has_gaps = ?, missing_segment_count = ?,
         stopped_at = ?, transcription_status = CASE
           WHEN auto_transcribe = ? THEN 'pending' ELSE 'off' END,
         updated_at = ? WHERE id = ? AND capture_status IN ('recording','paused','interrupted','finalizing')`,
      [
        expectedLastSequence,
        missingSequences.length > 0,
        missingSequences.length,
        stoppedAt,
        this.db.provider === "d1" ? 1 : true,
        stoppedAt,
        recordingId,
      ],
    );
    return (await this.recording(recordingId))!;
  }

  async claimTranscription(segment: Segment): Promise<string> {
    const token = createId("lease");
    const now = Date.now();
    const result = await this.db.execute(
      `UPDATE meeting_recorder_segments SET transcription_status = 'processing',
          transcription_lease_token = ?, transcription_lease_expires_at = ?,
          transcription_attempts = transcription_attempts + 1, updated_at = ?
        WHERE id = ? AND storage_status = 'stored' AND
          (transcription_status IN ('pending','failed','quota_wait') OR
           (transcription_status = 'processing' AND transcription_lease_expires_at < ?))`,
      [
        token,
        time(this.db, now + 120_000),
        time(this.db, now),
        segment.id,
        time(this.db, now),
      ],
    );
    if (!result.rowsAffected)
      throw new MeetingRecorderError(
        409,
        "TRANSCRIPTION_BUSY",
        "This segment is already being transcribed.",
      );
    return token;
  }

  async completeTranscription(
    segment: Segment,
    lease: string,
    textValue: string,
    vtt: string,
  ): Promise<void> {
    const now = time(this.db);
    await this.db.atomic([
      {
        sql: `UPDATE meeting_recorder_segments SET transcription_status = 'ready',
               transcript_text = ?, transcript_vtt = ?, transcribed_at = ?, updated_at = ?,
               transcription_lease_token = NULL, transcription_lease_expires_at = NULL,
               transcription_error_code = NULL
              WHERE id = ? AND transcription_lease_token = ?`,
        params: [textValue, vtt, now, now, segment.id, lease],
      },
      {
        sql: `UPDATE meeting_recorder_recordings SET
                transcribed_segment_count = (
                  SELECT COUNT(*) FROM meeting_recorder_segments
                   WHERE recording_id = ? AND transcription_status = 'ready'
                ),
                transcription_status = CASE WHEN NOT EXISTS (
                  SELECT 1 FROM meeting_recorder_segments
                   WHERE recording_id = ? AND storage_status = 'stored'
                     AND transcription_status <> 'ready'
                ) THEN 'ready' ELSE 'processing' END,
                updated_at = ? WHERE id = ?`,
        params: [
          segment.recordingId,
          segment.recordingId,
          now,
          segment.recordingId,
        ],
      },
    ]);
  }

  async failTranscription(
    segment: Segment,
    lease: string,
    code: string,
  ): Promise<void> {
    const quota = code === "AI_QUOTA_EXCEEDED" || code === "AI_RATE_LIMITED";
    await this.db.atomic([
      {
        sql: `UPDATE meeting_recorder_segments SET transcription_status = ?,
                transcription_error_code = ?, transcription_lease_token = NULL,
                transcription_lease_expires_at = NULL, transcription_next_retry_at = ?, updated_at = ?
              WHERE id = ? AND transcription_lease_token = ?`,
        params: [
          quota ? "quota_wait" : "failed",
          code,
          time(this.db, Date.now() + (quota ? 3_600_000 : 60_000)),
          time(this.db),
          segment.id,
          lease,
        ],
      },
      {
        sql: `UPDATE meeting_recorder_recordings SET transcription_status = ?, updated_at = ? WHERE id = ?`,
        params: [
          quota ? "quota_wait" : "partial",
          time(this.db),
          segment.recordingId,
        ],
      },
    ]);
  }

  async transcript(recordingId: string) {
    const segments = await this.segments(recordingId);
    return {
      text: segments
        .map((segment) => segment.transcriptText)
        .filter(Boolean)
        .join("\n\n"),
      vtt: [
        "WEBVTT",
        "",
        ...segments.flatMap((segment) =>
          segment.transcriptVtt
            ? [shiftedVtt(segment.transcriptVtt, segment.startOffsetMs), ""]
            : [],
        ),
      ].join("\n"),
      segments: segments.map((segment) => ({
        sequence: segment.sequence,
        startOffsetMs: segment.startOffsetMs,
        status: segment.transcriptionStatus,
        text: segment.transcriptText,
      })),
    };
  }

  async settings() {
    const row = await this.db.first<{
      defaultLanguage: string;
      autoTranscribe: boolean | number;
      maximumMinutes: number;
      storageLimitBytes: number | string;
      version: number;
      updatedAt: unknown;
    }>(
      `SELECT default_language AS "defaultLanguage", auto_transcribe AS "autoTranscribe",
              maximum_minutes AS "maximumMinutes", storage_limit_bytes AS "storageLimitBytes",
              version, updated_at AS "updatedAt"
         FROM meeting_recorder_settings WHERE scope = 'global'`,
    );
    return row
      ? {
          ...row,
          autoTranscribe: Boolean(row.autoTranscribe),
          storageLimitBytes: Number(row.storageLimitBytes),
        }
      : {
          defaultLanguage: "pt-BR",
          autoTranscribe: true,
          maximumMinutes: 240,
          storageLimitBytes: 8 * 1024 * 1024 * 1024,
          version: 0,
          updatedAt: null,
        };
  }

  async updateSettings(input: {
    defaultLanguage: string;
    autoTranscribe: boolean;
    maximumMinutes: number;
    storageLimitBytes: number;
    version: number;
    userId: string;
  }) {
    const now = time(this.db);
    if (input.version === 0) {
      try {
        await this.db.execute(
          `INSERT INTO meeting_recorder_settings(scope, default_language, auto_transcribe,
             maximum_minutes, storage_limit_bytes, version, updated_by_user_id, created_at, updated_at)
           VALUES ('global', ?, ?, ?, ?, 1, ?, ?, ?)`,
          [
            input.defaultLanguage,
            input.autoTranscribe,
            input.maximumMinutes,
            input.storageLimitBytes,
            input.userId,
            now,
            now,
          ],
        );
      } catch {
        throw new MeetingRecorderError(
          409,
          "VERSION_CONFLICT",
          "Settings changed before they could be saved.",
        );
      }
    } else {
      const result = await this.db.execute(
        `UPDATE meeting_recorder_settings SET default_language = ?, auto_transcribe = ?,
           maximum_minutes = ?, storage_limit_bytes = ?, version = version + 1,
           updated_by_user_id = ?, updated_at = ? WHERE scope = 'global' AND version = ?`,
        [
          input.defaultLanguage,
          input.autoTranscribe,
          input.maximumMinutes,
          input.storageLimitBytes,
          input.userId,
          now,
          input.version,
        ],
      );
      if (!result.rowsAffected)
        throw new MeetingRecorderError(
          409,
          "VERSION_CONFLICT",
          "Settings changed before they could be saved.",
        );
    }
    return this.settings();
  }

  async storageTotals() {
    const row = await this.db.first<{
      totalBytes: string | number;
      recordings: string | number;
      segments: string | number;
    }>(
      `SELECT COALESCE(SUM(total_bytes),0) AS "totalBytes", COUNT(*) AS recordings,
              COALESCE(SUM(stored_segment_count),0) AS segments
         FROM meeting_recorder_recordings`,
    );
    return {
      totalBytes: Number(row?.totalBytes ?? 0),
      recordings: Number(row?.recordings ?? 0),
      segments: Number(row?.segments ?? 0),
    };
  }
}

export { time as repositoryTime };
