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
    sqlite.exec(
      readFileSync(
        resolve(
          "plugins/meeting_recorder/migrations/d1/0003_telegram_user_links.sql",
        ),
        "utf8",
      ),
    );
    sqlite.exec(
      readFileSync(
        resolve(
          "plugins/meeting_recorder/migrations/d1/0004_telegram_members.sql",
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
      INSERT INTO meeting_recorder_telegram_configuration(
        id,bot_id,username,display_name,webhook_url,verified_at,
        updated_by_user_id,updated_at
      ) VALUES (
        'bot','123456','nexus_audio_bot','Nexus Audio',
        'https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook',
        1787900000000,'usr_telegram',1787900000000
      );
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
    const sentMessages: string[] = [];
    const telegramFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/getFile"))
          return Response.json({
            ok: true,
            result: {
              file_path: "voice/test.ogg",
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
        if (url.pathname.endsWith("/sendMessage")) {
          sentMessages.push(
            (JSON.parse(String(init?.body)) as { text: string }).text,
          );
          return Response.json({ ok: true, result: { message_id: 99 } });
        }
        throw new Error(
          `Unexpected Telegram URL: ${url.origin}${url.pathname}`,
        );
      },
    );
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
    expect(telegramFetch).toHaveBeenCalledTimes(5);
    expect(
      telegramFetch.mock.calls.some(
        ([input, init]) =>
          new URL(String(input)).pathname.includes("/file/bot") &&
          init?.redirect === "follow",
      ),
    ).toBe(true);
    expect(sentMessages).toEqual([
      "Áudio recebido.",
      "Iniciando transcrição.",
      expect.stringMatching(
        /^Transcrição pronta\.\nhttps:\/\/nexus\.example\/app\/meeting-recorder\/mrr_tg_/u,
      ),
    ]);
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
    expect(telegramFetch).toHaveBeenCalledTimes(5);
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

  it("links the authenticated user through a short-lived Telegram deep link", async () => {
    sqlite.exec(`
      INSERT OR IGNORE INTO "user"(id,name,active)
        VALUES ('usr_link','Link User',1);
      INSERT OR IGNORE INTO group_members(group_id,user_id)
        VALUES ('grp_recorder','usr_link');
      INSERT OR REPLACE INTO meeting_recorder_telegram_configuration(
        id,bot_id,username,display_name,webhook_url,verified_at,
        updated_by_user_id,updated_at
      ) VALUES (
        'bot','123456','nexus_audio_bot','Nexus Audio',
        'https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook',
        1787900000000,'usr_telegram',1787900000000
      );
    `);
    const sentMessages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/sendMessage")) {
          const body = JSON.parse(String(init?.body)) as { text: string };
          sentMessages.push(body.text);
          return Response.json({ ok: true, result: { message_id: 101 } });
        }
        throw new Error(`Unexpected Telegram URL: ${path}`);
      }),
    );
    const userContext = encodeContext({
      userId: "usr_link",
      requestId: "req_telegram_link",
      origin: "https://nexus.example",
      permissions: [
        "meeting_recorder.recording.create",
        "meeting_recorder.settings.read",
      ],
    });
    const requested = await app.request(
      "/telegram/link-requests",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": "telegram-link-request-test",
          "X-Plugin-Context": userContext,
        },
      },
      env,
    );
    expect(requested.status).toBe(201);
    const link = (await requested.json()) as {
      url: string;
      expiresAt: number;
    };
    const start = new URL(link.url).searchParams.get("start");
    expect(link.url).toMatch(
      /^https:\/\/t\.me\/nexus_audio_bot\?start=nexus_/u,
    );
    expect(link.expiresAt).toBeGreaterThan(Date.now());
    expect(start).toMatch(/^nexus_[A-Za-z0-9_-]{43}$/u);

    const publicContext = encodeContext({
      pluginId: "meeting_recorder",
      requestId: "req_telegram_link_webhook",
    });
    const linked = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": publicContext,
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9010,
          message: {
            message_id: 20,
            date: 1_787_900_200,
            text: `/start ${start}`,
            from: { id: 777777, first_name: "Linked", username: "linked_user" },
            chat: { id: 777777, type: "private" },
          },
        }),
      },
      env,
    );
    expect(linked.status).toBe(200);
    await expect(linked.json()).resolves.toEqual({ ok: true, linked: true });
    expect(sentMessages.at(-1)).toContain("Conta vinculada com sucesso");
    expect(
      sqlite
        .prepare(
          `SELECT user_id AS userId, telegram_id AS telegramId,
                  telegram_username AS username
             FROM meeting_recorder_telegram_user_links WHERE user_id = ?`,
        )
        .get("usr_link"),
    ).toMatchObject({
      userId: "usr_link",
      telegramId: "777777",
      username: "linked_user",
    });

    const settings = await app.request(
      "/settings",
      { headers: { "X-Plugin-Context": userContext } },
      env,
    );
    await expect(settings.json()).resolves.toMatchObject({
      telegram: {
        userLink: {
          linked: true,
          telegramId: "777777",
          username: "linked_user",
        },
      },
    });

    const textUpdate = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": publicContext,
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9011,
          message: {
            message_id: 21,
            date: 1_787_900_201,
            text: "Olá",
            from: { id: 777777, first_name: "Linked" },
            chat: { id: 777777, type: "private" },
          },
        }),
      },
      env,
    );
    expect(textUpdate.status).toBe(200);
    expect(
      sqlite
        .prepare(
          `SELECT owner_user_id AS ownerUserId, error_code AS errorCode
             FROM meeting_recorder_ingest_events
            WHERE external_event_id = '9011'`,
        )
        .get(),
    ).toMatchObject({
      ownerUserId: "usr_link",
      errorCode: "TELEGRAM_AUDIO_REQUIRED",
    });
  });

  it("invites, scopes, uses, and revokes an external Telegram member", async () => {
    sqlite.exec(`
      INSERT OR IGNORE INTO "user"(id,name,active)
        VALUES ('usr_inviter','Invitation Owner',1);
      INSERT OR IGNORE INTO "user"(id,name,active)
        VALUES ('usr_other','Other Owner',1);
      INSERT OR IGNORE INTO group_members(group_id,user_id)
        VALUES ('grp_recorder','usr_inviter');
      INSERT OR IGNORE INTO group_members(group_id,user_id)
        VALUES ('grp_recorder','usr_other');
      INSERT OR REPLACE INTO meeting_recorder_telegram_configuration(
        id,bot_id,username,display_name,webhook_url,verified_at,
        updated_by_user_id,updated_at
      ) VALUES (
        'bot','123456','nexus_audio_bot','Nexus Audio',
        'https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook',
        1787900000000,'usr_inviter',1787900000000
      );
    `);
    const sentMessages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/sendMessage")) {
          const body = JSON.parse(String(init?.body)) as { text: string };
          sentMessages.push(body.text);
          return Response.json({ ok: true, result: { message_id: 102 } });
        }
        throw new Error(`Unexpected Telegram URL: ${path}`);
      }),
    );
    const ownerContext = encodeContext({
      userId: "usr_inviter",
      requestId: "req_telegram_invitation",
      origin: "https://nexus.example",
      permissions: [
        "meeting_recorder.recording.create",
        "meeting_recorder.telegram_member.read",
        "meeting_recorder.telegram_member.invite",
        "meeting_recorder.telegram_member.delete",
      ],
    });
    const deniedContext = encodeContext({
      userId: "usr_other",
      requestId: "req_telegram_invitation_denied",
      origin: "https://nexus.example",
      permissions: ["meeting_recorder.recording.create"],
    });
    const invitationSettings = await app.request(
      "/settings",
      { headers: { "X-Plugin-Context": ownerContext } },
      env,
    );
    expect(invitationSettings.status).toBe(200);
    const deniedSettings = await app.request(
      "/settings",
      { headers: { "X-Plugin-Context": deniedContext } },
      env,
    );
    expect(deniedSettings.status).toBe(403);
    const denied = await app.request(
      "/telegram/invitations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "telegram-invitation-denied",
          "X-Plugin-Context": deniedContext,
        },
        body: JSON.stringify({ label: "Should not exist" }),
      },
      env,
    );
    expect(denied.status).toBe(403);

    const created = await app.request(
      "/telegram/invitations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "telegram-invitation-create",
          "X-Plugin-Context": ownerContext,
        },
        body: JSON.stringify({ label: "Guest Speaker" }),
      },
      env,
    );
    expect(created.status).toBe(201);
    const invitation = (await created.json()) as {
      id: string;
      label: string;
      url: string;
      expiresAt: number;
    };
    expect(invitation.id).toMatch(/^tgi_[a-f0-9]{32}$/u);
    expect(invitation.label).toBe("Guest Speaker");
    expect(invitation.expiresAt).toBeGreaterThan(
      Date.now() + 6 * 24 * 60 * 60 * 1_000,
    );
    const start = new URL(invitation.url).searchParams.get("start");
    expect(start).toMatch(/^nexus_inv_[A-Za-z0-9_-]{43}$/u);
    const rawToken = start!.replace(/^nexus_inv_/u, "");
    expect(
      sqlite
        .prepare(
          `SELECT token_hash AS tokenHash
             FROM meeting_recorder_telegram_invitations WHERE id = ?`,
        )
        .get(invitation.id),
    ).not.toMatchObject({ tokenHash: rawToken });

    const pending = await app.request(
      "/telegram/access",
      { headers: { "X-Plugin-Context": ownerContext } },
      env,
    );
    await expect(pending.json()).resolves.toMatchObject({
      items: [
        {
          id: invitation.id,
          kind: "invitation",
          label: "Guest Speaker",
          ownerUserId: "usr_inviter",
          status: "pending",
          telegramId: null,
        },
      ],
    });
    const otherReadContext = encodeContext({
      userId: "usr_other",
      requestId: "req_telegram_invitation_other_read",
      origin: "https://nexus.example",
      permissions: [
        "meeting_recorder.telegram_member.read",
        "meeting_recorder.telegram_member.delete",
      ],
    });
    const otherPending = await app.request(
      "/telegram/access",
      { headers: { "X-Plugin-Context": otherReadContext } },
      env,
    );
    await expect(otherPending.json()).resolves.toEqual({ items: [] });

    const publicContext = encodeContext({
      pluginId: "meeting_recorder",
      requestId: "req_telegram_invitation_accept",
    });
    const accepted = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": publicContext,
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9020,
          message: {
            message_id: 30,
            date: 1_787_900_300,
            text: `/start ${start}`,
            from: {
              id: 888888,
              first_name: "Guest",
              last_name: "Speaker",
              username: "guest_speaker",
            },
            chat: { id: 888888, type: "private" },
          },
        }),
      },
      env,
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ ok: true, linked: true });
    expect(sentMessages.at(-1)).toContain(
      "Seus áudios serão transcritos e enviados para Invitation Owner",
    );
    const member = sqlite
      .prepare(
        `SELECT id,owner_user_id AS ownerUserId,telegram_id AS telegramId,
                telegram_username AS username,
                telegram_display_name AS displayName,label,revoked_at AS revokedAt
           FROM meeting_recorder_telegram_members WHERE telegram_id = ?`,
      )
      .get("888888") as Record<string, unknown>;
    expect(member).toMatchObject({
      ownerUserId: "usr_inviter",
      telegramId: "888888",
      username: "guest_speaker",
      displayName: "Guest Speaker",
      label: "Guest Speaker",
      revokedAt: null,
    });

    const active = await app.request(
      "/telegram/access",
      { headers: { "X-Plugin-Context": ownerContext } },
      env,
    );
    await expect(active.json()).resolves.toMatchObject({
      items: [
        {
          id: member.id,
          kind: "member",
          status: "active",
          ownerUserId: "usr_inviter",
          telegramId: "888888",
        },
      ],
    });

    const textUpdate = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": encodeContext({
            pluginId: "meeting_recorder",
            requestId: "req_telegram_invited_text",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9021,
          message: {
            message_id: 31,
            date: 1_787_900_301,
            text: "Olá",
            from: { id: 888888, first_name: "Guest" },
            chat: { id: 888888, type: "private" },
          },
        }),
      },
      env,
    );
    expect(textUpdate.status).toBe(200);
    expect(
      sqlite
        .prepare(
          `SELECT owner_user_id AS ownerUserId,error_code AS errorCode
             FROM meeting_recorder_ingest_events WHERE external_event_id = '9021'`,
        )
        .get(),
    ).toMatchObject({
      ownerUserId: "usr_inviter",
      errorCode: "TELEGRAM_AUDIO_REQUIRED",
    });
    expect(
      sqlite
        .prepare(
          "SELECT last_used_at AS lastUsedAt FROM meeting_recorder_telegram_members WHERE id = ?",
        )
        .get(member.id as string),
    ).toMatchObject({ lastUsedAt: expect.any(Number) });

    const forbiddenRemoval = await app.request(
      `/telegram/members/${String(member.id)}`,
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "telegram-member-remove-other",
          "X-Plugin-Context": otherReadContext,
        },
      },
      env,
    );
    expect(forbiddenRemoval.status).toBe(404);
    const removed = await app.request(
      `/telegram/members/${String(member.id)}`,
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": "telegram-member-remove-owner",
          "X-Plugin-Context": ownerContext,
        },
      },
      env,
    );
    expect(removed.status).toBe(204);
    const afterRemoval = await app.request(
      "/telegram/access",
      { headers: { "X-Plugin-Context": ownerContext } },
      env,
    );
    await expect(afterRemoval.json()).resolves.toEqual({ items: [] });

    const blocked = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": encodeContext({
            pluginId: "meeting_recorder",
            requestId: "req_telegram_invited_blocked",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9022,
          message: {
            message_id: 32,
            date: 1_787_900_302,
            text: "Ainda autorizado?",
            from: { id: 888888, first_name: "Guest" },
            chat: { id: 888888, type: "private" },
          },
        }),
      },
      env,
    );
    expect(blocked.status).toBe(200);
    expect(
      sqlite
        .prepare(
          `SELECT owner_user_id AS ownerUserId,error_code AS errorCode
             FROM meeting_recorder_ingest_events WHERE external_event_id = '9022'`,
        )
        .get(),
    ).toMatchObject({
      ownerUserId: null,
      errorCode: "TELEGRAM_USER_NOT_LINKED",
    });

    const reinvitedResponse = await app.request(
      "/telegram/invitations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "telegram-invitation-reinvite",
          "X-Plugin-Context": ownerContext,
        },
        body: JSON.stringify({ label: "Guest Speaker Again" }),
      },
      env,
    );
    const reinvitation = (await reinvitedResponse.json()) as {
      url: string;
    };
    const restart = new URL(reinvitation.url).searchParams.get("start");
    const reaccepted = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": encodeContext({
            pluginId: "meeting_recorder",
            requestId: "req_telegram_invitation_reaccept",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9023,
          message: {
            message_id: 33,
            date: 1_787_900_303,
            text: `/start ${restart}`,
            from: {
              id: 888888,
              first_name: "Guest",
              last_name: "Speaker",
              username: "guest_speaker",
            },
            chat: { id: 888888, type: "private" },
          },
        }),
      },
      env,
    );
    expect(reaccepted.status).toBe(200);
    await expect(reaccepted.json()).resolves.toEqual({
      ok: true,
      linked: true,
    });
    expect(
      sqlite
        .prepare(
          `SELECT owner_user_id AS ownerUserId,label,revoked_at AS revokedAt
             FROM meeting_recorder_telegram_members WHERE telegram_id = ?`,
        )
        .get("888888"),
    ).toMatchObject({
      ownerUserId: "usr_inviter",
      label: "Guest Speaker Again",
      revokedAt: null,
    });
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
    const sentMessages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        if (url.pathname.endsWith("/sendMessage")) {
          sentMessages.push(
            (JSON.parse(String(init?.body)) as { text: string }).text,
          );
          return Response.json({ ok: true, result: { message_id: 100 } });
        }
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
    expect(sentMessages).toEqual([
      "Áudio recebido.",
      "Iniciando transcrição.",
      expect.stringMatching(
        /^Transcrição pronta\. Como o R2 está desativado, o áudio não foi armazenado\.\nhttps:\/\/nexus\.example\/app\/meeting-recorder\/mrr_tg_/u,
      ),
    ]);

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

  it("reports transient transcription failures to Telegram", async () => {
    const audio = new Uint8Array([79, 103, 103, 83, 4, 3, 2, 1]);
    const sentMessages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/getFile"))
          return Response.json({
            ok: true,
            result: {
              file_path: "voice/failure.ogg",
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
        if (url.pathname.endsWith("/sendMessage")) {
          sentMessages.push(
            (JSON.parse(String(init?.body)) as { text: string }).text,
          );
          return Response.json({ ok: true, result: { message_id: 102 } });
        }
        throw new Error(`Unexpected Telegram URL: ${url.pathname}`);
      }),
    );
    const transientEnv = {
      ...env,
      AI: {
        run: vi.fn(async () => {
          throw new Error("inference timeout");
        }),
      } as unknown as Ai,
    };
    delete transientEnv.STORAGE;
    const response = await app.request(
      "/public/telegram/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Plugin-Public-Context": encodeContext({
            pluginId: "meeting_recorder",
            requestId: "req_telegram_failure",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9004,
          message: {
            message_id: 14,
            date: 1_787_900_110,
            from: { id: 424242, first_name: "Telegram" },
            chat: { id: 424242 },
            voice: {
              file_id: "failure-file-id",
              file_unique_id: "failure-unique-id",
              duration: 2,
              file_size: audio.byteLength,
              mime_type: "audio/ogg",
            },
          },
        }),
      },
      transientEnv,
    );

    expect(response.status).toBe(503);
    expect(sentMessages).toEqual([
      "Áudio recebido.",
      "Iniciando transcrição.",
      expect.stringMatching(
        /^O processamento falhou \(AI_TIMEOUT\)\. O Telegram tentará entregar novamente; se não concluir, envie o áudio mais uma vez\.\nhttps:\/\/nexus\.example\/app\/meeting-recorder\/mrr_tg_/u,
      ),
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT status, error_code AS errorCode
             FROM meeting_recorder_ingest_events
            WHERE external_event_id = '9004'`,
        )
        .get(),
    ).toMatchObject({ status: "failed", errorCode: "AI_TIMEOUT" });
  });

  it("reports a Telegram media download failure without exposing the token", async () => {
    const sentMessages: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/getFile"))
          return Response.json({
            ok: true,
            result: { file_path: "voice/unavailable.ogg", file_size: 8 },
          });
        if (url.pathname.includes("/file/bot"))
          throw new TypeError("provider redirect failed with a sensitive URL");
        if (url.pathname.endsWith("/sendMessage")) {
          sentMessages.push(
            (JSON.parse(String(init?.body)) as { text: string }).text,
          );
          return Response.json({ ok: true, result: { message_id: 103 } });
        }
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
            requestId: "req_telegram_download_failure",
          }),
          "X-Telegram-Bot-Api-Secret-Token": "s".repeat(32),
        },
        body: JSON.stringify({
          update_id: 9005,
          message: {
            message_id: 15,
            date: 1_787_900_120,
            from: { id: 424242, first_name: "Telegram" },
            chat: { id: 424242 },
            voice: {
              file_id: "unavailable-file-id",
              file_unique_id: "unavailable-unique-id",
              duration: 2,
              file_size: 8,
              mime_type: "audio/ogg",
            },
          },
        }),
      },
      transientEnv,
    );

    expect(response.status).toBe(503);
    expect(sentMessages).toEqual([
      "Áudio recebido.",
      "O processamento falhou (TELEGRAM_FILE_UNAVAILABLE). O Telegram tentará entregar novamente; se não concluir, envie o áudio mais uma vez.",
    ]);
    expect(sentMessages.join(" ")).not.toContain("sensitive URL");
    expect(
      sqlite
        .prepare(
          `SELECT status, error_code AS errorCode
             FROM meeting_recorder_ingest_events
            WHERE external_event_id = '9005'`,
        )
        .get(),
    ).toMatchObject({
      status: "failed",
      errorCode: "TELEGRAM_FILE_UNAVAILABLE",
    });
  });
});
