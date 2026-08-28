export const TRANSCRIPTION_MODELS = [
  "@cf/openai/whisper-large-v3-turbo",
  "@cf/deepgram/nova-3",
] as const;

export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel =
  "@cf/openai/whisper-large-v3-turbo";

export const isTranscriptionModel = (
  value: unknown,
): value is TranscriptionModel =>
  typeof value === "string" &&
  TRANSCRIPTION_MODELS.some((model) => model === value);

export const resolveTranscriptionModel = (
  value: unknown,
): TranscriptionModel =>
  isTranscriptionModel(value) ? value : DEFAULT_TRANSCRIPTION_MODEL;
