export class MeetingRecorderError extends Error {
  constructor(
    readonly status:
      400 | 401 | 403 | 404 | 409 | 413 | 416 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MeetingRecorderError";
  }
}

export const errorCodeForTranscription = (cause: unknown): string => {
  const detail =
    cause instanceof Error
      ? `${cause.name} ${cause.message}`.toLowerCase()
      : String(cause).toLowerCase();
  if (/\b3036\b|daily free allocation|quota/iu.test(detail))
    return "AI_QUOTA_EXCEEDED";
  if (/\b3040\b|out of capacity|rate.?limit|\b429\b/iu.test(detail))
    return "AI_RATE_LIMITED";
  if (/\b3007\b|\b3008\b|abort|timeout/iu.test(detail)) return "AI_TIMEOUT";
  return "TRANSCRIPTION_FAILED";
};
