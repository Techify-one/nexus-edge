import type { DatabasePort, SqlStatement } from "@app/database";
import { describe, expect, it, vi } from "vitest";
import { MeetingRecorderRepository, type Segment } from "../src/repository.js";

describe("Meeting Recorder repository", () => {
  it("counts a stored segment only while its row is not already stored", async () => {
    const batches: SqlStatement[][] = [];
    const db: DatabasePort = {
      provider: "d1",
      orm: {},
      query: async () => [],
      first: async () => null,
      execute: async () => ({ rowsAffected: 0 }),
      atomic: async (statements) => {
        batches.push(statements);
        return statements.map(() => ({ rowsAffected: 1 }));
      },
      close: async () => undefined,
    };
    const segment = {
      id: "mrs_test",
      recordingId: "mrr_test",
      sequence: 0,
      startOffsetMs: 0,
      durationMs: 10_000,
      mimeType: "audio/webm",
      sizeBytes: 80_000,
      checksumSha256: "checksum",
      storageStatus: "uploading",
    } as Segment;
    await new MeetingRecorderRepository(db).markStored(segment, {
      etag: "etag",
      version: "version",
    } as R2Object);

    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.sql).toContain("storage_status <> 'stored'");
    expect(batches[0]?.[0]?.sql).toContain("stored_segment_count + 1");
    expect(batches[0]?.[1]?.sql).toContain("SET storage_status = 'stored'");
  });

  it("offsets segment WebVTT cues onto the recording timeline", async () => {
    const db = {
      provider: "d1",
      orm: {},
      close: async () => undefined,
    } as DatabasePort;
    const repository = new MeetingRecorderRepository(db);
    vi.spyOn(repository, "segments").mockResolvedValue([
      {
        sequence: 1,
        startOffsetMs: 10_000,
        transcriptionStatus: "ready",
        transcriptText: "Hello",
        transcriptVtt: "WEBVTT\n\n00:00.000 --> 00:02.500\nHello",
      } as Segment,
    ]);

    const transcript = await repository.transcript("mrr_test");

    expect(transcript.vtt.match(/WEBVTT/gu)).toHaveLength(1);
    expect(transcript.vtt).toContain("00:00:10.000 --> 00:00:12.500");
  });
});
