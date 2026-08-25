import { Buffer } from "node:buffer";
import type { SoletrandoBindings } from "./env.js";

const MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
export const TRANSCRIPTION_TIMEOUT_MS = 25_000;

export class TranscriptionUnavailableError extends Error {}

export async function transcribeSpelling(
  audio: File,
  env: SoletrandoBindings,
  signal: AbortSignal = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
): Promise<string> {
  if (!env.AI)
    throw new TranscriptionUnavailableError(
      "A transcrição está temporariamente indisponível.",
    );
  const audioBytes = await audio.arrayBuffer();
  const result = await env.AI.run(
    MODEL,
    {
      audio: Buffer.from(audioBytes).toString("base64"),
      task: "transcribe",
      language: "pt",
      vad_filter: true,
      condition_on_previous_text: false,
      no_speech_threshold: 0.55,
      initial_prompt:
        'Áudio curto de uma criança brasileira soletrando. Transcreva cada nome de letra como uma única letra maiúscula separada por hífen. Não forme palavras e não corrija o que foi falado. Exemplo: "agá, ó, erre, a" deve ser H - O - R - A. Para "erre", escreva somente R; para "a", escreva somente A. Nunca acrescente E antes de R nem I antes de A. Formato: A - M - T.',
    },
    { signal, tags: ["soletrando", "transcription"] },
  );
  const transcript = result.text?.trim() ?? "";
  if (transcript) return transcript;
  throw new TranscriptionUnavailableError(
    "Não consegui entender o áudio. Fale uma letra de cada vez e tente novamente.",
  );
}
