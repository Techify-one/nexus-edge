import type { DatabasePort, SqlValue } from "@app/database";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import app from "../src/index.js";

const sqliteValue = (value: SqlValue): string | number | null | Uint8Array => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
};

class SqliteD1Statement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: SqlValue[] = [],
  ) {}

  bind(...params: SqlValue[]): SqliteD1Statement {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async all<T extends Record<string, unknown>>() {
    return {
      results: this.database
        .prepare(this.sql)
        .all(...this.params.map(sqliteValue)) as T[],
      success: true,
      meta: {},
    };
  }

  async first<T extends Record<string, unknown>>(): Promise<T | null> {
    return (
      (this.database.prepare(this.sql).get(...this.params.map(sqliteValue)) as
        T | undefined) ?? null
    );
  }

  async run() {
    const result = this.database
      .prepare(this.sql)
      .run(...this.params.map(sqliteValue));
    return {
      success: true,
      meta: { changes: Number(result.changes) },
    };
  }
}

class SqliteD1Database {
  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteD1Statement {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

type StoredObject = {
  bytes: Uint8Array;
  etag: string;
  sha256: ArrayBuffer;
  contentType: string;
};

class MemoryR2Bucket {
  readonly objects = new Map<string, StoredObject>();

  private object(key: string, stored: StoredObject): R2Object {
    return {
      key,
      version: "test-version",
      size: stored.bytes.byteLength,
      etag: stored.etag,
      httpEtag: `\"${stored.etag}\"`,
      uploaded: new Date(),
      httpMetadata: { contentType: stored.contentType },
      customMetadata: {},
      range: undefined,
      checksums: { sha256: stored.sha256 },
      writeHttpMetadata: () => undefined,
    } as unknown as R2Object;
  }

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream,
    options: R2PutOptions = {},
  ): Promise<R2Object> {
    const bytes = new Uint8Array(
      value instanceof ReadableStream
        ? await new Response(value).arrayBuffer()
        : ArrayBuffer.isView(value)
          ? value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength,
            )
          : value,
    );
    const sha256 =
      options.sha256 ?? (await crypto.subtle.digest("SHA-256", bytes));
    const stored = {
      bytes,
      etag: `etag-${key}`,
      sha256,
      contentType:
        options.httpMetadata?.contentType ?? "application/octet-stream",
    };
    this.objects.set(key, stored);
    return this.object(key, stored);
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key);
    return stored ? this.object(key, stored) : null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const range = options?.range;
    const bytes =
      range && "offset" in range
        ? stored.bytes.slice(range.offset, range.offset + range.length)
        : stored.bytes;
    const object = this.object(key, stored);
    return {
      ...object,
      body: new Response(bytes).body!,
      bodyUsed: false,
      arrayBuffer: async () => bytes.slice().buffer,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      blob: async () => new Blob([bytes], { type: stored.contentType }),
    } as unknown as R2ObjectBody;
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys])
      this.objects.delete(key);
  }
}

const encodeContext = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("Meeting Recorder Telegram ingest", () => {
  let sqlite: DatabaseSync;
  let storage: MemoryR2Bucket;
  let env: Record<string, unknown>;

  beforeAll(() => {
    sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE "user" (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, active INTEGER NOT NULL
      );
      CREATE TABLE user_profiles (
        user_id TEXT PRIMARY KEY REFERENCES "user"(id), telegram_id TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE groups (id TEXT PRIMARY KEY);
      CREATE TABLE permissions (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE);
      CREATE TABLE group_members (
        group_id TEXT NOT NULL, user_id TEXT NOT NULL,
        PRIMARY KEY(group_id, user_id)
      );
      CREATE TABLE group_permissions (
        group_id TEXT NOT NULL, permission_id TEXT NOT NULL,
        PRIMARY KEY(group_id, permission_id)
      );
      CREATE TABLE audit_log (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, user_id TEXT,
        auth_method TEXT NOT NULL, action TEXT NOT NULL,
        resource_type TEXT NOT NULL, resource_id TEXT,
        metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
    sqlite.exec(
      readFileSync(
        resolve("plugins/meeting_recorder/migrations/d1/0001_init.sql"),
        "utf8",
      ),
    );
    sqlite.exec(
      readFileSync(
        resolve(
          "plugins/meeting_recorder/migrations/d1/0002_telegram_configuration.sql",
        ),
        "utf8",
      ),
    );
    sqlite.exec(`
      INSERT INTO "user"(id,name,active) VALUES ('usr_telegram','Telegram User',1);
      INSERT INTO user_profiles(user_id,telegram_id,status)
        VALUES ('usr_telegram','424242','active');
      INSERT INTO groups(id) VALUES ('grp_recorder');
      INSERT INTO permissions(id,key)
        VALUES ('perm_recorder_create','meeting_recorder.recording.create');
      INSERT INTO group_members(group_id,user_id)
        VALUES ('grp_recorder','usr_telegram');
      INSERT INTO group_permissions(group_id,permission_id)
        VALUES ('grp_recorder','perm_recorder_create');
    `);

    const d1 = new SqliteD1Database(sqlite);
    storage = new MemoryR2Bucket();
    env = {
      DATABASE_PROVIDER: "d1",
      DB: d1 as unknown as D1Database,
      STORAGE: storage as unknown as R2Bucket,
      AI: {
        run: vi.fn(async () => ({
          text: "Audio recebido pelo Telegram e transcrito.",
          vtt: "WEBVTT\n\n00:00.000 --> 00:02.000\nAudio recebido pelo Telegram e transcrito.",
        })),
      } as unknown as Ai,
      TELEGRAM_BOT_TOKEN: `123456:${"t".repeat(24)}`,
      TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
    };
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => sqlite.close());

  it("downloads, stores, transcribes and exposes Telegram audio idempotently", async () => {
    const audio = new Uint8Array([79, 103, 103, 83, 0, 1, 2, 3]);
    const telegramFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/getFile"))
        return Response.json({
          ok: true,
          result: { file_path: "voice/test.ogg", file_size: audio.byteLength },
        });
      if (url.pathname.includes("/file/bot"))
        return new Response(audio, {
          headers: {
            "Content-Type": "audio/ogg",
            "Content-Length": String(audio.byteLength),
          },
        });
      throw new Error(`Unexpected Telegram URL: ${url.origin}${url.pathname}`);
    });
    vi.stubGlobal("fetch", telegramFetch);

    const publicContext = encodeContext({
      pluginId: "meeting_recorder",
      requestId: "req_telegram_ingest",
    });
    const update = {
      update_id: 9001,
      message: {
        message_id: 11,
        date: 1_787_900_000,
        caption: "Reunião enviada pelo bot",
        from: { id: 424242, first_name: "Telegram" },
        chat: { id: 424242 },
        voice: {
          file_id: "voice-file-id",
          file_unique_id: "voice-unique-id",
          duration: 2,
          file_size: audio.byteLength,
          mime_type: "audio/ogg",
        },
      },
    };
    const webhookRequest = () =>
      app.request(
        "/public/telegram/webhook",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Plugin-Public-Context": publicContext,
            "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
          },
          body: JSON.stringify(update),
        },
        env,
      );

    const received = await webhookRequest();
    expect(received.status).toBe(200);
    const payload = (await received.json()) as {
      ok: boolean;
      recordingId: string;
    };
    expect(payload).toMatchObject({ ok: true });
    expect(telegramFetch).toHaveBeenCalledTimes(2);
    expect(storage.objects.size).toBe(1);

    const database = new SqliteD1Database(sqlite) as unknown as D1Database;
    const db = (await import("@app/database")).createDatabase({
      DATABASE_PROVIDER: "d1",
      DB: database,
    }) as Promise<DatabasePort>;
    const port = await db;
    const row = await port.first<{
      source: string;
      status: string;
      ownerId: string;
      transcript: string;
    }>(
      `SELECT r.ingest_source AS source, e.status, r.owner_user_id AS "ownerId",
              s.transcript_text AS transcript
         FROM meeting_recorder_recordings r
         JOIN meeting_recorder_ingest_events e ON e.recording_id = r.id
         JOIN meeting_recorder_segments s ON s.recording_id = r.id
        WHERE r.id = ?`,
      [payload.recordingId],
    );
    expect(row).toMatchObject({
      source: "telegram",
      status: "transcribed",
      ownerId: "usr_telegram",
      transcript: "Audio recebido pelo Telegram e transcrito.",
    });

    const userContext = encodeContext({
      userId: "usr_telegram",
      requestId: "req_telegram_read",
      origin: "https://nexus.example",
      permissions: ["meeting_recorder.recording.read"],
    });
    const transcript = await app.request(
      `/recordings/${payload.recordingId}/transcript`,
      { headers: { "X-Plugin-Context": userContext } },
      env,
    );
    expect(transcript.status).toBe(200);
    await expect(transcript.json()).resolves.toMatchObject({
      text: "Audio recebido pelo Telegram e transcrito.",
    });
    const playable = await app.request(
      `/recordings/${payload.recordingId}/segments/0/audio`,
      { headers: { "X-Plugin-Context": userContext } },
      env,
    );
    expect(playable.status).toBe(200);
    expect(new Uint8Array(await playable.arrayBuffer())).toEqual(audio);

    const replay = await webhookRequest();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      replay: true,
    });
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });

  it("verifies, exposes, and disconnects the configured Telegram bot", async () => {
    let webhookConfigured = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/getMe"))
          return Response.json({
            ok: true,
            result: {
              id: 123456,
              is_bot: true,
              first_name: "Nexus Audio",
              username: "nexus_audio_bot",
            },
          });
        if (path.endsWith("/getWebhookInfo"))
          return Response.json({
            ok: true,
            result: {
              url: webhookConfigured
                ? "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook"
                : "https://old.example/webhook",
            },
          });
        if (path.endsWith("/setWebhook")) {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            url: "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook",
          });
          webhookConfigured = true;
          return Response.json({ ok: true, result: true });
        }
        if (path.endsWith("/deleteWebhook")) {
          webhookConfigured = false;
          return Response.json({ ok: true, result: true });
        }
        throw new Error(`Unexpected Telegram URL: ${path}`);
      }),
    );
    const pluginContext = encodeContext({
      userId: "usr_telegram",
      requestId: "req_telegram_configuration",
      origin: "https://nexus.example",
      permissions: [
        "meeting_recorder.settings.read",
        "meeting_recorder.settings.update",
      ],
    });
    const headers = {
      "Content-Type": "application/json",
      "Idempotency-Key": "configure-telegram-test",
      "X-Plugin-Context": pluginContext,
    };
    const wrongEndpoint = await app.request(
      "/telegram/configure",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          webhookUrl: "https://nexus.example/not-the-telegram-webhook",
        }),
      },
      env,
    );
    expect(wrongEndpoint.status).toBe(422);
    await expect(wrongEndpoint.json()).resolves.toMatchObject({
      error: { code: "TELEGRAM_WEBHOOK_URL_INVALID" },
    });

    const configured = await app.request(
      "/telegram/configure",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          webhookUrl:
            "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook",
        }),
      },
      env,
    );
    expect(configured.status).toBe(200);
    await expect(configured.json()).resolves.toMatchObject({
      configured: true,
      webhookChanged: true,
      bot: {
        id: "123456",
        username: "nexus_audio_bot",
        link: "https://t.me/nexus_audio_bot",
      },
      webhook: { verified: true },
    });

    const settings = await app.request(
      "/settings",
      { headers: { "X-Plugin-Context": pluginContext } },
      env,
    );
    await expect(settings.json()).resolves.toMatchObject({
      telegram: {
        configured: true,
        bot: {
          name: "Nexus Audio",
          link: "https://t.me/nexus_audio_bot",
        },
        webhook: {
          url: "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook",
        },
      },
    });

    const disconnected = await app.request(
      "/telegram/configuration",
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "disconnect-telegram-test",
          "X-Plugin-Context": pluginContext,
        },
      },
      env,
    );
    expect(disconnected.status).toBe(204);
    expect(webhookConfigured).toBe(false);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM meeting_recorder_telegram_configuration",
        )
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it("rejects a webhook update with the wrong Telegram secret", async () => {
    const response = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": encodeContext({
            pluginId: "meeting_recorder",
            requestId: "req_bad_secret",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "x".repeat(32),
        },
        body: JSON.stringify({ update_id: 9002 }),
      },
      env,
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TELEGRAM_WEBHOOK_UNAUTHORIZED" },
    });
  });

  it("transcribes Telegram audio without R2 and retains only the transcript", async () => {
    const audio = new Uint8Array([79, 103, 103, 83, 9, 8, 7, 6]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/getFile"))
          return Response.json({
            ok: true,
            result: {
              file_path: "voice/transient.ogg",
              file_size: audio.byteLength,
            },
          });
        if (url.pathname.includes("/file/bot"))
          return new Response(audio, {
            headers: {
              "Content-Type": "audio/ogg",
              "Content-Length": String(audio.byteLength),
            },
          });
        throw new Error(`Unexpected Telegram URL: ${url.pathname}`);
      }),
    );
    const transientEnv = { ...env };
    delete transientEnv.STORAGE;
    const response = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": encodeContext({
            pluginId: "meeting_recorder",
            requestId: "req_telegram_transient",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9003,
          message: {
            message_id: 13,
            date: 1_787_900_100,
            caption: "Áudio sem R2",
            from: { id: 424242, first_name: "Telegram" },
            chat: { id: 424242 },
            voice: {
              file_id: "transient-file-id",
              file_unique_id: "transient-unique-id",
              duration: 3,
              file_size: audio.byteLength,
              mime_type: "audio/ogg",
            },
          },
        }),
      },
      transientEnv,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      recordingId: string;
      audioRetained: boolean;
    };
    expect(payload.audioRetained).toBe(false);

    const row = sqlite
      .prepare(
        `SELECT r.transcription_status AS transcriptionStatus,
                r.total_bytes AS totalBytes,
                r.timeline_duration_ms AS timelineDurationMs,
                s.storage_status AS storageStatus,
                s.transcript_text AS transcript,
                e.status AS eventStatus
           FROM meeting_recorder_recordings r
           JOIN meeting_recorder_segments s ON s.recording_id = r.id
           JOIN meeting_recorder_ingest_events e ON e.recording_id = r.id
          WHERE r.id = ?`,
      )
      .get(payload.recordingId) as Record<string, unknown>;
    expect(row).toMatchObject({
      transcriptionStatus: "ready",
      totalBytes: 0,
      timelineDurationMs: 3000,
      storageStatus: "missing",
      transcript: "Audio recebido pelo Telegram e transcrito.",
      eventStatus: "transcribed",
    });

    const audioResponse = await app.request(
      `/recordings/${payload.recordingId}/segments/0/audio`,
      {
        headers: {
          "X-Plugin-Context": encodeContext({
            userId: "usr_telegram",
            requestId: "req_transient_audio",
            origin: "https://nexus.example",
            permissions: ["meeting_recorder.recording.read"],
          }),
        },
      },
      transientEnv,
    );
    expect(audioResponse.status).toBe(409);
    await expect(audioResponse.json()).resolves.toMatchObject({
      error: { code: "R2_NOT_ENABLED" },
    });
  });
});
