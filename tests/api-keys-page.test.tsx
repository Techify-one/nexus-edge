/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ApiKeysPage from "../frontend/src/features/api-keys/ApiKeysPage.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("API keys page", () => {
  it("links to the API documentation on the current browser origin", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.endsWith("/api/v1/me/api-keys")
          ? { apiKeys: [] }
          : url.endsWith("/api/v1/me/permissions")
            ? { items: [] }
            : { tableId: "core.api-keys", config: null, updatedAt: null };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ApiKeysPage />
        </I18nProvider>
      </QueryClientProvider>,
    );

    const link = screen.getByRole("link", {
      name: /^(Documentação da API|API documentation)$/,
    });
    expect(link.getAttribute("href")).toBe(
      new URL("/api/docs", window.location.origin).href,
    );
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
