import type { SoletrandoBindings } from "./env.js";
export declare const TRANSCRIPTION_TIMEOUT_MS = 25000;
export declare class TranscriptionUnavailableError extends Error {
}
export declare function transcribeSpelling(audio: File, env: SoletrandoBindings, signal?: AbortSignal): Promise<string>;
