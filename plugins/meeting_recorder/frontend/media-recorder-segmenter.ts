export type CompletedMediaSegment = {
  blob: Blob;
  sequence: number;
  startOffsetMs: number;
  durationMs: number;
  mimeType: string;
};

const supportedMimeType = (): string => {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];
  return (
    candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ??
    ""
  );
};

export const preferredRecorderMimeType = supportedMimeType;

export class IndependentMediaSegmenter {
  private active: MediaRecorder | null = null;
  private timer: number | null = null;
  private stopped = false;
  private paused = false;
  private sequence: number;
  private readonly epoch: number;
  private activeCompletion: Promise<void> | null = null;

  constructor(
    private readonly stream: MediaStream,
    private readonly segmentDurationMs: number,
    initialSequence: number,
    private readonly onSegment: (
      segment: CompletedMediaSegment,
    ) => Promise<void>,
  ) {
    this.sequence = initialSequence;
    this.epoch = performance.now();
  }

  start(): void {
    if (this.stopped || this.active || this.paused) return;
    this.rotate();
  }

  private rotate(): void {
    if (this.stopped || this.paused) return;
    const startedAt = performance.now();
    const chunks: BlobPart[] = [];
    const mimeType = supportedMimeType();
    const recorder = new MediaRecorder(this.stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: 64_000,
    });
    this.active = recorder;
    this.activeCompletion = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      });
      recorder.addEventListener(
        "error",
        (event) =>
          reject(
            event instanceof ErrorEvent && event.error instanceof Error
              ? event.error
              : new Error("MEDIA_RECORDER_FAILED"),
          ),
        { once: true },
      );
      recorder.addEventListener(
        "stop",
        () => {
          const durationMs = Math.max(
            1_000,
            Math.round(performance.now() - startedAt),
          );
          const blob = new Blob(chunks, {
            type: recorder.mimeType || mimeType || "audio/webm",
          });
          const completedSequence = this.sequence++;
          this.active = null;
          this.timer = null;
          void (async () => {
            if (blob.size > 0)
              await this.onSegment({
                blob,
                sequence: completedSequence,
                startOffsetMs: Math.max(0, Math.round(startedAt - this.epoch)),
                durationMs,
                mimeType: blob.type || "audio/webm",
              });
          })()
            .then(() => {
              resolve();
              if (!this.stopped && !this.paused) this.rotate();
            })
            .catch(reject);
        },
        { once: true },
      );
      recorder.start();
      this.timer = window.setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, this.segmentDurationMs);
    });
  }

  async pause(): Promise<void> {
    this.paused = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.active?.state !== "inactive") this.active?.stop();
    await this.activeCompletion;
  }

  resume(): void {
    if (this.stopped) return;
    this.paused = false;
    this.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.active?.state !== "inactive") this.active?.stop();
    await this.activeCompletion;
  }

  nextSequence(): number {
    return this.sequence;
  }
}
