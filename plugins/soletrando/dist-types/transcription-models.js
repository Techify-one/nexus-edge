export const TRANSCRIPTION_MODELS = [
    "@cf/openai/whisper-large-v3-turbo",
    "@cf/deepgram/nova-3",
];
export const DEFAULT_TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const isTranscriptionModel = (value) => typeof value === "string" &&
    TRANSCRIPTION_MODELS.some((model) => model === value);
export const resolveTranscriptionModel = (value) => isTranscriptionModel(value) ? value : DEFAULT_TRANSCRIPTION_MODEL;
