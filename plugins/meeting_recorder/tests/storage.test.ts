import { afterEach, describe, expect, it, vi } from "vitest";
import {
  base64Sha256,
  putAudioStream,
} from "../src/storage.js";

const bytes = new TextEncoder().encode("meeting recorder stream");

function installFixedLengthStream(lengths: number[]): void {
  class TestFixedLengthStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;

    constructor(length: number | bigint) {
      lengths.push(Number(length));
      const stream = new TransformStream<Uint8Array, Uint8Array>();
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  }
  vi.stubGlobal("FixedLengthStream", TestFixedLengthStream);
}

function storageMock() {
  return {
    head: vi.fn(async () => null),
    put: vi.fn(
      async (
        key: string,
        value: ReadableStream,
        options: R2PutOptions,
      ) => {
        const uploaded = new Uint8Array(
          await new Response(value as BodyInit).arrayBuffer(),
        );
        return {
          key,
          version: "version-1",
          size: uploaded.byteLength,
          etag: "etag-1",
          httpEtag: '"etag-1"',
          uploaded: new Date(),
          httpMetadata: options.httpMetadata ?? {},
          customMetadata: options.customMetadata ?? {},
          checksums: { sha256: options.sha256 as ArrayBuffer },
          storageClass: "Standard",
          writeHttpMetadata: () => undefined,
        } as R2Object;
      },
    ),
    delete: vi.fn(async () => undefined),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("meeting recorder R2 streaming", () => {
  it("restores the declared length after inspecting the upload stream", async () => {
    const lengths: number[] = [];
    installFixedLengthStream(lengths);
    const storage = storageMock();
    const checksumBase64 = await base64Sha256(bytes.slice().buffer);

    const result = await putAudioStream({
      storage: storage as unknown as R2Bucket,
      key: "recordings/test/segments/000000.webm",
      body: new Blob([bytes]).stream(),
      mimeType: "audio/webm",
      expectedBytes: bytes.byteLength,
      checksumBase64,
      maximumBytes: 1_024,
      metadata: { recordingId: "test" },
    });

    expect(lengths).toEqual([bytes.byteLength]);
    expect(storage.put).toHaveBeenCalledOnce();
    expect(result.object.size).toBe(bytes.byteLength);
    expect(result.replay).toBe(false);
  });

  it("rejects a stream shorter than its declared byte count", async () => {
    installFixedLengthStream([]);
    const storage = storageMock();
    const checksumBase64 = await base64Sha256(bytes.slice().buffer);

    await expect(
      putAudioStream({
        storage: storage as unknown as R2Bucket,
        key: "recordings/test/segments/000001.webm",
        body: new Blob([bytes]).stream(),
        mimeType: "audio/webm",
        expectedBytes: bytes.byteLength + 1,
        checksumBase64,
        maximumBytes: 1_024,
        metadata: { recordingId: "test" },
      }),
    ).rejects.toMatchObject({ status: 422, code: "SEGMENT_SIZE_MISMATCH" });
  });
});
