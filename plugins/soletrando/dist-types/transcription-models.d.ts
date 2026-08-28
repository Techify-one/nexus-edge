export declare const TRANSCRIPTION_MODELS: readonly ["@cf/openai/whisper-large-v3-turbo", "@cf/deepgram/nova-3"];
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];
export declare const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModel;
export declare const isTranscriptionModel: (value: unknown) => value is TranscriptionModel;
export declare const resolveTranscriptionModel: (value: unknown) => TranscriptionModel;
