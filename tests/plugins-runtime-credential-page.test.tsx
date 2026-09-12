/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginsPage from "../frontend/src/features/plugins/PluginsPage.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ability } from "../frontend/src/lib/ability.js";

afterEach(() => {
  cleanup();
  ability.update([]);
  vi.restoreAllMocks();
});

function renderPage(configured: boolean) {
  const accountId = "a".repeat(32);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const body = url.endsWith("/api/v1/plugins")
        ? { items: [] }
        : url.endsWith("/api/v1/plugin-runtime-credential")
          ? { configured, accountId }
          : url.endsWith("/api/v1/plugin-marketplaces") ||
              url.endsWith("/api/v1/plugin-catalog")
            ? { items: [] }
            : { tableId: "core.plugins", config: null, updatedAt: null };
      return Response.json(body);
    }),
  );
  ability.update([{ action: "manage", subject: "all" }]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <PluginsPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { accountId, requests };
}

describe("plugin runtime credential onboarding", () => {
  it("checks the credential on page entry and opens the guided setup when absent", async () => {
    const { accountId, requests } = renderPage(false);

    expect(
      await screen.findByRole("heading", {
        name: /^(Autorize a publicação do primeiro plugin|Authorize the first plugin deployment)$/,
      }),
    ).toBeTruthy();
    expect(requests).toContain("/api/v1/plugin-runtime-credential");

    const createLink = screen.getByRole("link", {
      name: /^(Criar token na Cloudflare|Create token in Cloudflare)$/,
    });
    const url = new URL(createLink.getAttribute("href") ?? "");
    expect(url.searchParams.get("to")).toBe(`/${accountId}/api-tokens`);
    expect(
      JSON.parse(url.searchParams.get("permissionGroupKeys") ?? "[]"),
    ).toEqual([{ key: "workers_scripts", type: "edit" }]);
    expect(
      screen.getByLabelText(/^(API Token dedicado|Dedicated API Token)$/),
    ).toHaveProperty("type", "password");
  });

  it("does not interrupt the page when the credential is already configured", async () => {
    renderPage(true);

    await waitFor(() => expect(screen.getByText(/^(Plugins)$/)).toBeTruthy());
    expect(
      screen.queryByRole("heading", {
        name: /^(Autorize a publicação do primeiro plugin|Authorize the first plugin deployment)$/,
      }),
    ).toBeNull();
  });

  it("separates installed plugins, new plugins, and marketplaces into tabs", async () => {
    renderPage(true);

    const installed = await screen.findByRole("tab", {
      name: /^(Instalados|Installed)$/,
    });
    const catalog = screen.getByRole("tab", {
      name: /^(Novos Plugins|New Plugins)$/,
    });
    const marketplaces = screen.getByRole("tab", { name: "Market Places" });
    expect(installed.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("heading", { name: /^(Instalados|Installed)$/ }),
    ).toBeTruthy();

    fireEvent.click(catalog);
    expect(catalog.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: /^(Explorar|Explore)$/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /^(Instalados|Installed)$/ }),
    ).toBeNull();

    fireEvent.click(marketplaces);
    expect(marketplaces.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "Marketplaces" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /^(Explorar|Explore)$/ }),
    ).toBeNull();
  });
});
