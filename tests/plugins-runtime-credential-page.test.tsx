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
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import PluginsPage from "../frontend/src/features/plugins/PluginsPage.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ability } from "../frontend/src/lib/ability.js";

afterEach(() => {
  cleanup();
  ability.update([]);
  vi.restoreAllMocks();
});

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="plugin-location">{location.pathname}</output>;
}

function renderPage(
  configured: boolean,
  options: {
    initialEntry?: string;
    plugins?: Array<Record<string, unknown>>;
    catalog?: Array<Record<string, unknown>>;
    marketplaces?: Array<Record<string, unknown>>;
  } = {},
) {
  const accountId = "a".repeat(32);
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      const body = url.endsWith("/api/v1/plugins")
        ? { items: options.plugins ?? [] }
        : url.endsWith("/api/v1/plugin-runtime-credential")
          ? { configured, accountId }
          : url.endsWith("/api/v1/plugin-marketplaces")
            ? { items: options.marketplaces ?? [] }
            : url.endsWith("/api/v1/plugin-catalog")
              ? { items: options.catalog ?? [] }
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
        <MemoryRouter
          initialEntries={[options.initialEntry ?? "/app/plugins/installed"]}
        >
          <Routes>
            <Route
              path="/app/plugins/:tab?"
              element={
                <>
                  <PluginsPage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
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
    expect(screen.getByTestId("plugin-location").textContent).toBe(
      "/app/plugins/catalog",
    );

    fireEvent.click(marketplaces);
    expect(marketplaces.getAttribute("aria-selected")).toBe("true");
    expect(
      await screen.findByRole("heading", { name: "Marketplaces" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /^(Explorar|Explore)$/ }),
    ).toBeNull();
    expect(screen.getByTestId("plugin-location").textContent).toBe(
      "/app/plugins/marketplaces",
    );
  });

  it("shows installed catalog entries and opens their complete description", async () => {
    const description =
      "Descrição completa do plugin, incluindo recursos, integrações e requisitos operacionais.";
    renderPage(true, {
      initialEntry: "/app/plugins/catalog",
      catalog: [
        {
          id: "rel_meta_ads",
          marketplaceId: "mkt_techfire",
          marketplaceName: "Techfire Plugins",
          pluginId: "meta_ads",
          publisherId: "techfire",
          publisherName: "Techfire",
          version: "2.0.0",
          description,
          compatible: true,
          compatibilityReason: null,
          packageBytes: 2048,
          installedVersion: "2.0.0",
          installedStatus: "installed",
          updateAvailable: false,
          sourceMatches: true,
        },
      ],
    });

    expect(
      (await screen.findAllByText(/^(Já instalado|Already installed)$/)).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("meta_ads"));
    expect(
      await screen.findByRole("heading", { name: "meta_ads" }),
    ).toBeTruthy();
    expect(screen.getAllByText(description).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("button", { name: /^(Instalar|Install)$/ }),
    ).toBeNull();
  });

  it("opens marketplace details for editing without synchronizing on row click", async () => {
    const { requests } = renderPage(true, {
      initialEntry: "/app/plugins/marketplaces",
      marketplaces: [
        {
          id: "mkt_techfire",
          name: "Techfire Plugins",
          owner: "Techify-one",
          repository: "nexus-edge-plugins",
          enabled: true,
          isDefault: true,
          trustState: "trusted",
          keyFingerprint: "fingerprint",
          lastSyncedAt: Date.now(),
          lastErrorCode: null,
        },
      ],
    });

    fireEvent.click(await screen.findByText(/Techfire Plugins ·/u));
    const name = await screen.findByLabelText(/^(Nome|Name)$/);
    expect(name).toHaveProperty("readOnly", false);
    fireEvent.change(name, { target: { value: "Meu marketplace" } });
    expect(name).toHaveProperty("value", "Meu marketplace");
    expect(requests.some((url) => url.endsWith("/mkt_techfire/sync"))).toBe(
      false,
    );
    expect(
      screen.getByRole("button", {
        name: /^(Copiar nome do marketplace|Copy marketplace name)$/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^(Desativar|Deactivate)$/ }),
    ).toBeTruthy();
  });

  it("offers activation and uninstall separately for a disabled plugin", async () => {
    renderPage(true, {
      plugins: [
        {
          id: "meta_ads",
          name: "Meta Ads",
          installedVersion: "2.0.0",
          apiVersion: 1,
          databaseProvider: "d1",
          workerName: "app-plugin-meta-ads",
          status: "disabled",
          installedAt: Date.now(),
          packageAvailable: true,
        },
      ],
    });

    expect(await screen.findByText(/^(Desativado|Disabled)$/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^(Ativar|Activate) Meta Ads$/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /^(Desinstalar|Uninstall) Meta Ads$/,
      }),
    ).toBeTruthy();
  });
});
