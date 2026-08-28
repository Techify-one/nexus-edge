import { Buffer } from "node:buffer";
import { errorCodeForTranscription, MeetingRecorderError } from "./errors.js";
import type { MeetingRecorderBindings } from "./env.js";

const MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
export const TRANSCRIPTION_TIMEOUT_MS = 55_000;

export type TranscriptResult = { text: string; vtt: string };

export async function transcribeAudio(
  env: MeetingRecorderBindings,
  bytes: ArrayBuffer,
  language: "pt-BR" | "en" | "auto",
  previousText = "",
): Promise<TranscriptResult> {
  if (!env.AI)
    throw new MeetingRecorderError(
      503,
      "TRANSCRIPTION_UNAVAILABLE",
      "Workers AI is not available for this plugin.",
    );
  try {
    const result = await env.AI.run(
      MODEL,
      {
        audio: Buffer.from(bytes).toString("base64"),
        task: "transcribe",
        ...(language === "auto"
          ? {}
          : { language: language === "pt-BR" ? "pt" : "en" }),
        vad_filter: true,
        condition_on_previous_text: false,
        no_speech_threshold: 0.6,
        ...(previousText ? { initial_prompt: previousText.slice(-500) } : {}),
      },
      {
        signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
        tags: ["meeting-recorder", "transcription"],
      },
    );
    const text = result.text?.trim() ?? "";
    return { text, vtt: result.vtt?.trim() ?? "" };
  } catch (cause) {
    const code = errorCodeForTranscription(cause);
    if (code === "AI_QUOTA_EXCEEDED" || code === "AI_RATE_LIMITED")
      throw new MeetingRecorderError(
        429,
        code,
        "The Workers AI quota is temporarily unavailable.",
      );
    throw new MeetingRecorderError(
      503,
      code,
      "The audio could not be transcribed.",
    );
  }
}
