import type { SoletrandoBindings } from "./env.js";
import { type TranscriptionModel } from "./transcription-models.js";
export declare const TRANSCRIPTION_TIMEOUT_MS = 25000;
export declare class TranscriptionUnavailableError extends Error {
}
type TranscriptionOptions = {
    model?: TranscriptionModel;
    signal?: AbortSignal;
};
export declare function transcribeSpelling(audio: File, env: SoletrandoBindings, options?: TranscriptionOptions): Promise<string>;
export {};
