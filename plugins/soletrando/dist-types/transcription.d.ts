import type { SoletrandoBindings } from "./env.js";
export declare class TranscriptionUnavailableError extends Error {
}
export declare function transcribeSpelling(audio: File, env: SoletrandoBindings): Promise<string>;
