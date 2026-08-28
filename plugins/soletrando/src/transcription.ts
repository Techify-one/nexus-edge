import { Buffer } from "node:buffer";
import type { SoletrandoBindings } from "./env.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  type TranscriptionModel,
} from "./transcription-models.js";

export const TRANSCRIPTION_TIMEOUT_MS = 25_000;

export class TranscriptionUnavailableError extends Error {}

type TranscriptionOptions = {
  model?: TranscriptionModel;
  signal?: AbortSignal;
};

const spellingPrompt =
  "Soletração infantil em português brasileiro. Transcreva literalmente os nomes das letras, na ordem falada, separados por vírgulas. Não una as letras para formar uma palavra, não complete e não corrija a soletração. Vocabulário: a, bê, cê, dê, e, efe, gê, agá, i, jota, cá, ele, eme, ene, ó, pê, quê, erre, esse, tê, u, vê, dáblio, xis, ípsilon, zê.";

const novaTranscript = (result: Ai_Cf_Deepgram_Nova_3_Output): string =>
  result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";

export async function transcribeSpelling(
  audio: File,
  env: SoletrandoBindings,
  options: TranscriptionOptions = {},
): Promise<string> {
  if (!env.AI)
    throw new TranscriptionUnavailableError(
      "A transcrição está temporariamente indisponível.",
    );
  const model = options.model ?? DEFAULT_TRANSCRIPTION_MODEL;
  const signal =
    options.signal ?? AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS);
  const audioBytes = await audio.arrayBuffer();
  const transcript =
    model === "@cf/deepgram/nova-3"
      ? novaTranscript(
          await env.AI.run(
            model,
            {
              audio: {
                body: audioBytes,
                contentType: audio.type || "application/octet-stream",
              },
              language: "pt-BR",
              mode: "general",
              channels: 1,
              punctuate: false,
              smart_format: false,
              numerals: false,
              mip_opt_out: true,
            },
            { signal, tags: ["soletrando", "transcription"] },
          ),
        )
      : ((
          await env.AI.run(
            model,
            {
              audio: Buffer.from(audioBytes).toString("base64"),
              task: "transcribe",
              language: "pt",
              vad_filter: true,
              condition_on_previous_text: false,
              no_speech_threshold: 0.55,
              initial_prompt: spellingPrompt,
            },
            { signal, tags: ["soletrando", "transcription"] },
          )
        ).text?.trim() ?? "");
  if (transcript) return transcript;
  throw new TranscriptionUnavailableError(
    "Não consegui entender o áudio. Fale uma letra de cada vez e tente novamente.",
  );
}
