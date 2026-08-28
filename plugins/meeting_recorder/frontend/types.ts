export type Recording = {
  id: string;
  clientSessionId: string;
  ownerUserId: string;
  ownerName: string | null;
  title: string;
  ingestSource: "live" | "upload" | "telegram";
  originalFileName: string | null;
  sourceType: string;
  captureStatus:
    | "recording"
    | "paused"
    | "interrupted"
    | "finalizing"
    | "complete"
    | "deleting";
  effectiveCaptureStatus: string;
  transcriptionStatus: string;
  language: "pt-BR" | "en" | "auto";
  mimeType: string;
  storedSegmentCount: number;
  transcribedSegmentCount: number;
  totalBytes: number;
  storedDurationMs: number;
  timelineDurationMs: number;
  hasGaps: boolean;
  missingSegmentCount: number;
  startedAt: string | number;
  stoppedAt: string | number | null;
  version: number;
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
  storageStatus: string;
  transcriptionStatus: string;
  transcriptText: string | null;
  transcriptVtt: string | null;
};

export type RecorderSourceMode = "microphone" | "microphone_tab";

export type LocalSegment = {
  recordingId: string;
  sequence: number;
  blob: Blob;
  mimeType: string;
  sizeBytes: number;
  startOffsetMs: number;
  durationMs: number;
  checksumSha256: string;
  clientSessionId: string;
  attempts: number;
  nextRetryAt: number;
};

export type LocalSession = {
  recordingId: string;
  clientSessionId: string;
  title: string;
  sourceMode: RecorderSourceMode;
  nextSequence: number;
  startedAt: number;
  accumulatedMs: number;
  state: "recording" | "paused" | "interrupted" | "finalizing";
};

export type Transcript = {
  text: string;
  vtt: string;
  segments: Array<{
    sequence: number;
    startOffsetMs: number;
    status: string;
    text: string | null;
  }>;
};
