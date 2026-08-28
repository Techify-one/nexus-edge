import { Buffer } from "node:buffer";
import type { SoletrandoBindings } from "./env.js";
import {
  DEFAULT_TRANSCRIPTION_MODEL,
  type TranscriptionModel,
} from "./transcription-models.js";
import { extractMonoPcm16Wav, SOLETRANDO_PCM_SAMPLE_RATE } from "./wav.js";

export const TRANSCRIPTION_TIMEOUT_MS = 25_000;

export class TranscriptionUnavailableError extends Error {}

type TranscriptionOptions = {
  model?: TranscriptionModel;
  signal?: AbortSignal;
};

const spellingPrompt =
  "Soletração infantil em português brasileiro. Transcreva literalmente os nomes das letras, na ordem falada, separados por vírgulas. Não una as letras para formar uma palavra, não complete e não corrija a soletração. Vocabulário: a, bê, cê, dê, e, efe, gê, agá, i, jota, cá, ele, eme, ene, ó, pê, quê, erre, esse, tê, u, vê, dáblio, xis, ípsilon, zê.";

type NovaSocketResponse = Response & { webSocket?: WebSocket };
type NovaSocketMessage = {
  type?: string;
  channel?: { alternatives?: Array<{ transcript?: string }> };
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
};

const transcribeNova = async (
  wavBytes: ArrayBuffer,
  ai: Ai,
  signal: AbortSignal,
): Promise<string> => {
  const pcm = extractMonoPcm16Wav(wavBytes);
  const looseAi = ai as unknown as {
    run(
      model: string,
      input: Record<string, unknown>,
      options: { websocket: true },
    ): Promise<NovaSocketResponse>;
  };
  const response = await looseAi.run(
    "@cf/deepgram/nova-3",
    {
      encoding: "linear16",
      sample_rate: String(SOLETRANDO_PCM_SAMPLE_RATE),
      language: "pt-BR",
      interim_results: "true",
      vad_events: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
      smart_format: "false",
      punctuate: "false",
      mip_opt_out: "true",
    },
    { websocket: true },
  );
  const socket = response.webSocket;
  if (!socket) throw new Error("Nova-3 WebSocket upgrade failed.");
  socket.accept();

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const segments: string[] = [];
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        socket.close();
      } catch {
        // The remote side may already have closed the socket.
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(segments.join(" ").trim());
    };
    const fail = (cause: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const onAbort = () =>
      fail(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const message = JSON.parse(event.data) as NovaSocketMessage;
        if (message.type === "Error") {
          fail(new Error("Nova-3 transcription failed."));
          return;
        }
        if (message.type !== "Results") return;
        const transcript =
          message.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
        if (message.is_final && transcript) segments.push(transcript);
        if (message.speech_final || message.from_finalize) finish();
      } catch {
        // Ignore non-JSON WebSocket control messages.
      }
    });
    socket.addEventListener("error", () =>
      fail(new Error("Nova-3 WebSocket failed.")),
    );
    socket.addEventListener("close", () => {
      if (segments.length) finish();
      else fail(new Error("Nova-3 WebSocket closed before transcription."));
    });
    if (signal.aborted) {
      onAbort();
      return;
    }
    const bytes = new Uint8Array(pcm);
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      socket.send(bytes.slice(offset, offset + 64 * 1024).buffer);
    }
    socket.send(JSON.stringify({ type: "Finalize" }));
  });
};

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
      ? await transcribeNova(audioBytes, env.AI, signal)
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
