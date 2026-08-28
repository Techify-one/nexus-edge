import { MeetingRecorderError } from "./errors.js";

export const LIVE_SEGMENT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

const mimeExtensions = new Map<string, string>([
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/mp4", "m4a"],
  ["audio/x-m4a", "m4a"],
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
]);

export const normalizedMime = (value: string): string =>
  value.trim().toLowerCase().split(";")[0] ?? "";

export const extensionForMime = (mimeType: string): string => {
  const extension = mimeExtensions.get(normalizedMime(mimeType));
  if (!extension)
    throw new MeetingRecorderError(
      422,
      "UNSUPPORTED_AUDIO_TYPE",
      "This audio format is not supported.",
    );
  return extension;
};

export const segmentObjectKey = (
  recordingId: string,
  sequence: number,
  mimeType: string,
): string =>
  `recordings/${recordingId}/segments/${String(sequence).padStart(6, "0")}.${extensionForMime(mimeType)}`;

export const decodeSha256 = (value: string): ArrayBuffer => {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
    );
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    if (bytes.byteLength !== 32) throw new Error("invalid length");
    return bytes.buffer;
  } catch {
    throw new MeetingRecorderError(
      422,
      "CHECKSUM_REQUIRED",
      "A valid SHA-256 checksum is required.",
    );
  }
};

export const base64Sha256 = async (bytes: ArrayBuffer): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const sameBytes = (
  left: ArrayBuffer | undefined,
  right: ArrayBuffer,
): boolean => {
  if (!left || left.byteLength !== right.byteLength) return false;
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  return a.every((value, index) => value === b[index]);
};

export async function putAudioStream(input: {
  storage: R2Bucket;
  key: string;
  body: ReadableStream;
  mimeType: string;
  expectedBytes: number;
  checksumBase64: string;
  maximumBytes: number;
  metadata: Record<string, string>;
}): Promise<{ object: R2Object; replay: boolean }> {
  if (input.expectedBytes <= 0 || input.expectedBytes > input.maximumBytes)
    throw new MeetingRecorderError(
      413,
      "SEGMENT_TOO_LARGE",
      "The audio object exceeds the allowed size.",
    );
  const sha256 = decodeSha256(input.checksumBase64);
  const prior = await input.storage.head(input.key);
  if (prior) {
    if (
      prior.size !== input.expectedBytes ||
      !sameBytes(prior.checksums.sha256, sha256)
    )
      throw new MeetingRecorderError(
        409,
        "SEGMENT_CONFLICT",
        "The object key already contains different audio.",
      );
    return { object: prior, replay: true };
  }
  let received = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > input.expectedBytes) {
        controller.error(new Error("SEGMENT_SIZE_MISMATCH"));
        return;
      }
      if (received > input.maximumBytes) {
        controller.error(new Error("SEGMENT_TOO_LARGE"));
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (received !== input.expectedBytes)
        controller.error(new Error("SEGMENT_SIZE_MISMATCH"));
    },
  });
  let object: R2Object | null;
  try {
    // A TransformStream no longer carries the request body's known length.
    // R2 requires a fixed-length stream for a transformed upload, so preserve
    // streaming/backpressure while explicitly restoring Content-Length.
    const fixedLength = new FixedLengthStream(input.expectedBytes);
    [object] = await Promise.all([
      input.storage.put(input.key, fixedLength.readable, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        sha256,
        httpMetadata: { contentType: input.mimeType },
        customMetadata: input.metadata,
      }),
      input.body.pipeThrough(counter).pipeTo(fixedLength.writable),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.message === "SEGMENT_TOO_LARGE")
      throw new MeetingRecorderError(
        413,
        "SEGMENT_TOO_LARGE",
        "The streamed audio object exceeds the allowed size.",
      );
    if (cause instanceof Error && cause.message === "SEGMENT_SIZE_MISMATCH")
      throw new MeetingRecorderError(
        422,
        "SEGMENT_SIZE_MISMATCH",
        "The streamed size differs from X-Segment-Bytes.",
      );
    throw cause;
  }
  if (object === null) {
    const raced = await input.storage.head(input.key);
    if (
      raced &&
      raced.size === input.expectedBytes &&
      sameBytes(raced.checksums.sha256, sha256)
    )
      return { object: raced, replay: true };
  }
  if (received !== input.expectedBytes) {
    if (object) await input.storage.delete(input.key);
    throw new MeetingRecorderError(
      422,
      "SEGMENT_SIZE_MISMATCH",
      "The streamed size differs from X-Segment-Bytes.",
    );
  }
  const stored = object ?? (await input.storage.head(input.key));
  if (!stored)
    throw new MeetingRecorderError(
      503,
      "R2_UNAVAILABLE",
      "The audio object could not be confirmed in storage.",
    );
  if (
    stored.size !== input.expectedBytes ||
    !sameBytes(stored.checksums.sha256, sha256)
  )
    throw new MeetingRecorderError(
      409,
      "CHECKSUM_MISMATCH",
      "The stored object does not match the declared audio.",
    );
  return { object: stored, replay: object === null };
}

export async function putAudioBuffer(input: {
  storage: R2Bucket;
  key: string;
  bytes: ArrayBuffer;
  mimeType: string;
  metadata: Record<string, string>;
}): Promise<{ object: R2Object; checksumBase64: string }> {
  if (input.bytes.byteLength <= 0 || input.bytes.byteLength > IMPORT_MAX_BYTES)
    throw new MeetingRecorderError(
      413,
      "AUDIO_IMPORT_TOO_LARGE",
      "Imported audio must be no larger than 20 MiB.",
    );
  extensionForMime(input.mimeType);
  const checksumBase64 = await base64Sha256(input.bytes);
  const object = await input.storage.put(input.key, input.bytes, {
    sha256: decodeSha256(checksumBase64),
    httpMetadata: { contentType: input.mimeType },
    customMetadata: input.metadata,
  });
  if (!object)
    throw new MeetingRecorderError(
      503,
      "R2_UNAVAILABLE",
      "The imported audio could not be stored.",
    );
  return { object, checksumBase64 };
}

export function parseRange(
  value: string | undefined,
  size: number,
): { offset: number; length: number } | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2]))
    throw new MeetingRecorderError(
      416,
      "RANGE_NOT_SATISFIABLE",
      "Invalid byte range.",
    );
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw new MeetingRecorderError(
        416,
        "RANGE_NOT_SATISFIABLE",
        "Invalid byte range.",
      );
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new MeetingRecorderError(
      416,
      "RANGE_NOT_SATISFIABLE",
      "Invalid byte range.",
    );
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}
