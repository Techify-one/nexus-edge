import type { RecorderSourceMode } from "./types.js";

export type CaptureMedia = {
  stream: MediaStream;
  close: () => void;
};

export async function acquireCaptureMedia(
  sourceMode: RecorderSourceMode,
): Promise<CaptureMedia> {
  const microphone = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let display: MediaStream | null = null;
  let context: AudioContext | null = null;
  try {
    if (sourceMode === "microphone") {
      return {
        stream: microphone,
        close: () => microphone.getTracks().forEach((track) => track.stop()),
      };
    }

    display = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    const displayAudio = display.getAudioTracks();
    if (displayAudio.length === 0) throw new Error("DISPLAY_AUDIO_REQUIRED");

    context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    context.createMediaStreamSource(microphone).connect(destination);
    context
      .createMediaStreamSource(new MediaStream(displayAudio))
      .connect(destination);
    const close = () => {
      microphone.getTracks().forEach((track) => track.stop());
      display?.getTracks().forEach((track) => track.stop());
      void context?.close();
    };
    display.getVideoTracks().forEach((track) => {
      track.addEventListener("ended", close, { once: true });
    });
    return { stream: destination.stream, close };
  } catch (error) {
    microphone.getTracks().forEach((track) => track.stop());
    display?.getTracks().forEach((track) => track.stop());
    void context?.close();
    throw error;
  }
}
