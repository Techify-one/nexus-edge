import {
  api,
  idempotencyKey,
} from "../../../frontend/src/lib/api/core-client.js";
import { getAppLocale } from "../../../frontend/src/i18n/index.js";
import type { LocalSegment, Recording, Segment, Transcript } from "./types.js";

const base = "/api/v1/p/meeting_recorder";

export const recorderApi = {
  health: () =>
    api<{ ok: boolean; plugin: string; version: string }>(`${base}/health`),
  overview: () =>
    api<{
      durationMs: number;
      storageBytes: number;
      transcriptionsReady: number;
      interrupted: number;
    }>(`${base}/overview`),
  recordings: (query: URLSearchParams) =>
    api<{ items: Recording[]; nextCursor: string | null }>(
      `${base}/recordings?${query.toString()}`,
    ),
  recording: (id: string) =>
    api<{ recording: Recording }>(
      `${base}/recordings/${encodeURIComponent(id)}`,
    ),
  rename: (id: string, title: string, version: number) =>
    api<{ recording: Recording }>(
      `${base}/recordings/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title, version }),
      },
    ),
  create: (input: Record<string, unknown>) =>
    api<{ recording: Recording }>(`${base}/recordings`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(input),
    }),
  createImport: (input: Record<string, unknown>) =>
    api<{ recording: Recording; uploadSequence: number }>(`${base}/imports`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(input),
    }),
  segments: (id: string) =>
    api<{ items: Segment[] }>(
      `${base}/recordings/${encodeURIComponent(id)}/segments`,
    ),
  transcript: (id: string) =>
    api<Transcript>(`${base}/recordings/${encodeURIComponent(id)}/transcript`),
  transcribe: (recordingId: string, sequence: number, checksum: string) =>
    api<{ segment: Segment }>(
      `${base}/recordings/${encodeURIComponent(recordingId)}/segments/${sequence}/transcribe`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `transcribe-${recordingId}-${sequence}-${checksum}`,
        },
      },
    ),
  finalize: (
    recordingId: string,
    expectedLastSequence: number,
    missingSequences: number[] = [],
  ) =>
    api<{ recording: Recording }>(
      `${base}/recordings/${encodeURIComponent(recordingId)}/finalize`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `finalize-${recordingId}-${expectedLastSequence}-${missingSequences.join("-")}`,
        },
        body: JSON.stringify({ expectedLastSequence, missingSequences }),
      },
    ),
  captureState: (recordingId: string, status: string) =>
    api(`${base}/recordings/${encodeURIComponent(recordingId)}/capture-state`, {
      method: "PUT",
      body: JSON.stringify({ status }),
    }),
  heartbeat: (recordingId: string) =>
    api(`${base}/recordings/${encodeURIComponent(recordingId)}/heartbeat`, {
      method: "PUT",
    }),
  settings: () =>
    api<{
      settings: {
        defaultLanguage: "pt-BR" | "en" | "auto";
        autoTranscribe: boolean;
        maximumMinutes: number;
        storageLimitBytes: number;
        version: number;
      };
      telegram: {
        botTokenConfigured: boolean;
        webhookSecretConfigured: boolean;
      };
    }>(`${base}/settings`),
  defaults: () =>
    api<{
      defaultLanguage: "pt-BR" | "en" | "auto";
      autoTranscribe: boolean;
      maximumMinutes: number;
    }>(`${base}/defaults`),
  saveSettings: (input: Record<string, unknown>) =>
    api(`${base}/settings`, { method: "PUT", body: JSON.stringify(input) }),
  configureTelegram: (webhookUrl: string) =>
    api(`${base}/telegram/configure`, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify({ webhookUrl }),
    }),
  deleteRecording: (
    recordingId: string,
    reauthHeaders: Record<string, string>,
  ) =>
    api<{ operationId: string }>(
      `${base}/recordings/${encodeURIComponent(recordingId)}`,
      { method: "DELETE", headers: reauthHeaders },
    ),
  deletionStep: (recordingId: string, operationId: string, step: number) =>
    api<{ complete: boolean; deletedSegments: number } | undefined>(
      `${base}/recordings/${encodeURIComponent(recordingId)}/deletion-steps`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": `delete-${recordingId}-${operationId}-${step}`,
        },
        body: JSON.stringify({ operationId }),
      },
    ),
};

export const segmentAudioUrl = (recordingId: string, sequence: number) =>
  `${base}/recordings/${encodeURIComponent(recordingId)}/segments/${sequence}/audio`;

export async function sha256Base64(blob: Blob): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function uploadSegment(segment: LocalSegment): Promise<void> {
  const response = await fetch(
    `${base}/recordings/${encodeURIComponent(segment.recordingId)}/segments/${segment.sequence}`,
    {
      method: "PUT",
      credentials: "include",
      headers: {
        "Accept-Language": getAppLocale(),
        "Content-Type": segment.mimeType,
        "X-Segment-SHA256": segment.checksumSha256,
        "X-Segment-Bytes": String(segment.sizeBytes),
        "X-Segment-Duration-Ms": String(segment.durationMs),
        "X-Segment-Start-Ms": String(segment.startOffsetMs),
        "X-Client-Session-Id": segment.clientSessionId,
      },
      body: segment.blob,
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(
      data?.error?.message || `Upload failed (${response.status})`,
    );
  }
}
