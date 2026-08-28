import type { SoletrandoBindings } from "./env.js";
import { type TranscriptionModel } from "./transcription-models.js";
export declare const TRANSCRIPTION_TIMEOUT_MS = 25000;
export declare class TranscriptionUnavailableError extends Error {
}
type TranscriptionOptions = {
    model?: TranscriptionModel;
    signal?: AbortSignal;
};
export declare const BRAZILIAN_PORTUGUESE_LETTER_NAMES: readonly ["a", "bê", "cê", "dê", "e", "efe", "gê", "agá", "i", "jota", "cá", "ele", "eme", "ene", "ó", "pê", "quê", "erre", "esse", "tê", "u", "vê", "dáblio", "xis", "ípsilon", "zê"];
export declare const SPELLING_INITIAL_PROMPT: string;
export declare function transcribeSpelling(audio: File, env: SoletrandoBindings, options?: TranscriptionOptions): Promise<string>;
export {};
