import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureTelegramWebhook,
  telegramSecretMatches,
} from "../src/telegram.js";

describe("Meeting Recorder Telegram integration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("compares webhook secrets without an early character exit", () => {
    expect(telegramSecretMatches("a".repeat(32), "a".repeat(32))).toBe(true);
    expect(telegramSecretMatches("a".repeat(32), `${"a".repeat(31)}b`)).toBe(
      false,
    );
    expect(telegramSecretMatches("short", "shorter")).toBe(false);
  });

  it("configures only the canonical HTTPS public gateway", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/getMe"))
          return Response.json({
            ok: true,
            result: {
              id: 123456,
              is_bot: true,
              first_name: "Nexus Recorder",
              username: "nexus_recorder_bot",
            },
          });
        if (path.endsWith("/getWebhookInfo"))
          return Response.json({
            ok: true,
            result: {
              url:
                fetchMock.mock.calls.length >= 4
                  ? "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook"
                  : "https://old.example/webhook",
            },
          });
        expect(path).toMatch(/\/setWebhook$/u);
        expect(JSON.parse(String(init?.body))).toMatchObject({
          url: "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook",
          secret_token: "s".repeat(32),
          allowed_updates: ["message"],
        });
        return Response.json({ ok: true, result: true });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const configured = await configureTelegramWebhook({
      token: `123456:${"t".repeat(24)}`,
      secret: "s".repeat(32),
      webhookUrl:
        "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook",
    });

    expect(configured).toMatchObject({
      bot: { id: 123456, username: "nexus_recorder_bot" },
      webhook: {
        url: "https://nexus.example/api/v1/public/p/meeting_recorder/telegram/webhook",
      },
      webhookChanged: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await expect(
      configureTelegramWebhook({
        token: `123456:${"t".repeat(24)}`,
        secret: "s".repeat(32),
        webhookUrl: "http://nexus.example/telegram/webhook",
      }),
    ).rejects.toMatchObject({ code: "TELEGRAM_WEBHOOK_URL_INVALID" });
  });
});
