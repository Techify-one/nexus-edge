import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreEnv } from "../workers/core/src/env.js";
import {
  configurePluginQueueConsumers,
  configurePluginWorkerSchedules,
  provisionPluginResource,
  uploadPluginWorker,
  type PluginRuntimeResource,
} from "../workers/core/src/installer/cloudflare.js";

const env = {
  CF_API_TOKEN: "worker-token",
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  DATABASE_PROVIDER: "d1",
  D1_DATABASE_ID: "database-id",
} as CoreEnv;

afterEach(() => vi.unstubAllGlobals());

describe("format 2 Cloudflare resource adapters", () => {
  it("renders generic bindings and declarative SQLite Durable Object exports", async () => {
    let metadata: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const part = (init?.body as FormData).get("metadata");
        metadata = JSON.parse(await (part as Blob).text()) as Record<
          string,
          unknown
        >;
        return Response.json({ success: true, result: {} });
      }),
    );
    const resources: PluginRuntimeResource[] = [
      {
        logicalName: "cache",
        type: "kv",
        binding: "CACHE",
        required: true,
        externalId: "11111111111111111111111111111111",
        externalName: "nexus-cache",
        configuration: {},
      },
      {
        logicalName: "events",
        type: "queue",
        binding: "EVENTS",
        required: true,
        externalId: "22222222222222222222222222222222",
        externalName: "nexus-events",
        configuration: { consumer: true },
      },
      {
        logicalName: "state",
        type: "durable_object",
        binding: "STATE",
        required: true,
        configuration: { className: "PluginState", storage: "sqlite" },
      },
      {
        logicalName: "models",
        type: "ai",
        binding: "MODELS",
        required: false,
        configuration: {},
      },
    ];
    await uploadPluginWorker(
      env,
      "plugin-worker",
      "export class PluginState {}; export default {};",
      {
        packageFormat: 2,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["nodejs_compat"],
      },
      resources,
    );
    expect(metadata).toMatchObject({
      main_module: "backend/worker.mjs",
      exports: {
        PluginState: { type: "durable-object", storage: "sqlite" },
      },
      bindings: expect.arrayContaining([
        {
          type: "kv_namespace",
          name: "CACHE",
          namespace_id: resources[0]!.externalId,
        },
        { type: "queue", name: "EVENTS", queue_name: "nexus-events" },
        {
          type: "durable_object_namespace",
          name: "STATE",
          class_name: "PluginState",
        },
        { type: "ai", name: "MODELS" },
      ]),
    });
  });

  it("reconciles Cron schedules and updates an existing Queue consumer", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url.endsWith("/schedules"))
          return Response.json({ success: true, result: { schedules: body } });
        if (method === "GET")
          return Response.json({
            success: true,
            result: [
              {
                consumer_id: "consumer-id",
                script_name: "plugin-worker",
                type: "worker",
              },
            ],
          });
        return Response.json({ success: true, result: {} });
      }),
    );
    const resources: PluginRuntimeResource[] = [
      {
        logicalName: "events_dlq",
        type: "queue",
        binding: "EVENTS_DLQ",
        required: true,
        externalId: "11111111111111111111111111111111",
        externalName: "events-dlq",
        configuration: {},
      },
      {
        logicalName: "events",
        type: "queue",
        binding: "EVENTS",
        required: true,
        externalId: "22222222222222222222222222222222",
        externalName: "events",
        configuration: {
          consumer: true,
          deadLetterResource: "events_dlq",
          settings: { batch_size: 10, max_retries: 3 },
        },
      },
      {
        logicalName: "hourly",
        type: "cron",
        binding: "HOURLY",
        required: true,
        configuration: { schedules: ["0 * * * *"] },
      },
    ];
    await configurePluginQueueConsumers(env, "plugin-worker", resources);
    await configurePluginWorkerSchedules(env, "plugin-worker", resources);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "PUT",
          url: expect.stringContaining("/consumers/consumer-id"),
          body: expect.objectContaining({
            script_name: "plugin-worker",
            dead_letter_queue: "events-dlq",
          }),
        }),
        expect.objectContaining({
          method: "PUT",
          url: expect.stringContaining("/schedules"),
          body: [{ cron: "0 * * * *" }],
        }),
      ]),
    );
  });

  it("creates and attaches KV/Queue resources using request-scoped tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/tokens/verify"))
          return Response.json({ success: true, result: { status: "active" } });
        if (url.endsWith("/storage/kv/namespaces"))
          return Response.json({
            success: true,
            result: {
              id: "11111111111111111111111111111111",
              title: "nexus-demo-cache",
            },
          });
        if (url.endsWith("/queues/22222222222222222222222222222222"))
          return Response.json({
            success: true,
            result: {
              queue_id: "22222222222222222222222222222222",
              queue_name: "nexus-demo-events",
            },
          });
        throw new Error(`${init?.method ?? "GET"} ${url}`);
      }),
    );
    const token = "x".repeat(40);
    await expect(
      provisionPluginResource(token, env.CF_ACCOUNT_ID!, {
        type: "kv",
        mode: "create",
        name: "nexus-demo-cache",
      }),
    ).resolves.toMatchObject({
      created: true,
      externalName: "nexus-demo-cache",
    });
    await expect(
      provisionPluginResource(token, env.CF_ACCOUNT_ID!, {
        type: "queue",
        mode: "attach",
        id: "22222222222222222222222222222222",
        name: "nexus-demo-events",
      }),
    ).resolves.toMatchObject({
      created: false,
      externalName: "nexus-demo-events",
    });
  });
});
