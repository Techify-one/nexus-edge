import { uploadSegment } from "./api-client.js";
import { localRecorderStore } from "./indexed-db.js";
import type { LocalSegment } from "./types.js";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

export type UploadQueueSnapshot = {
  pending: number;
  uploading: number;
  failed: number;
};

export class SegmentUploadQueue {
  private readonly pending: LocalSegment[] = [];
  private active = 0;
  private failed = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly onChange: (snapshot: UploadQueueSnapshot) => void,
    private readonly concurrency = 2,
    private readonly onUploaded?: (segment: LocalSegment) => void,
  ) {}

  enqueue(segment: LocalSegment): void {
    if (
      this.pending.some(
        (candidate) =>
          candidate.recordingId === segment.recordingId &&
          candidate.sequence === segment.sequence,
      )
    )
      return;
    this.pending.push(segment);
    this.emit();
    this.pump();
  }

  private emit(): void {
    this.onChange({
      pending: this.pending.length,
      uploading: this.active,
      failed: this.failed,
    });
    if (this.pending.length === 0 && this.active === 0) {
      this.waiters.splice(0).forEach((resolve) => resolve());
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const segment = this.pending.shift()!;
      this.active += 1;
      this.emit();
      void this.uploadWithRetry(segment).finally(() => {
        this.active -= 1;
        this.emit();
        this.pump();
      });
    }
  }

  private async uploadWithRetry(segment: LocalSegment): Promise<void> {
    let current = segment;
    while (current.attempts < 6) {
      try {
        if (!navigator.onLine) await delay(1_000);
        await uploadSegment(current);
        await localRecorderStore.removeSegment(
          current.recordingId,
          current.sequence,
        );
        this.onUploaded?.(current);
        return;
      } catch {
        const attempts = current.attempts + 1;
        const waitMs = Math.min(30_000, 1_000 * 2 ** attempts);
        current = {
          ...current,
          attempts,
          nextRetryAt: Date.now() + waitMs,
        };
        await localRecorderStore.saveSegment(current);
        await delay(waitMs);
      }
    }
    this.failed += 1;
  }

  drain(): Promise<void> {
    if (this.pending.length === 0 && this.active === 0)
      return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  hasFailures(): boolean {
    return this.failed > 0;
  }
}
