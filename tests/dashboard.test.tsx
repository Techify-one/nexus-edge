/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardPage, {
  normalizeOverviewOrder,
  reorderOverviewCardIds,
} from "../frontend/src/features/dashboard.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ability } from "../frontend/src/lib/ability.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  ability.update([]);
});

describe("Overview navigation", () => {
  it("keeps saved items, removes unavailable items, and appends new ones", () => {
    expect(
      normalizeOverviewOrder(
        ["plugin.crm", "core.users", "plugin.removed"],
        ["core.users", "core.groups", "plugin.crm"],
      ),
    ).toEqual(["plugin.crm", "core.users", "core.groups"]);
    expect(
      reorderOverviewCardIds(
        ["plugin.crm", "core.users", "core.groups"],
        "core.groups",
        "plugin.crm",
      ),
    ).toEqual(["core.groups", "plugin.crm", "core.users"]);
  });

  it("renders Core modules and plugins as peers under one search", async () => {
    ability.update([{ action: "manage", subject: "all" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me/overview-preference"))
          return Response.json({ config: null, updatedAt: null });
        return Response.json({
          plugins: [
            {
              pluginId: "crm",
              name: "CRM",
              menu: [
                { title: "CRM", routeKey: "crm.home" },
                { title: "Leads", routeKey: "crm.leads" },
              ],
            },
            {
              pluginId: "meta_ads",
              name: "Meta Ads",
              menu: [
                {
                  title: "Meta Ads",
                  routeKey: "meta_ads.dashboard",
                },
                {
                  title: "Contas de anúncios",
                  routeKey: "meta_ads.accounts",
                },
              ],
            },
          ],
        });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <DashboardPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(
      (
        await screen.findByRole("link", { name: /CRM/ }, { timeout: 5_000 })
      ).getAttribute("href"),
    ).toBe("/app/crm");
    expect(
      screen.getByRole("link", { name: /Meta Ads/ }).getAttribute("href"),
    ).toBe("/app/meta-ads");
    expect(
      screen
        .getByRole("link", { name: /Chaves de API|API keys/ })
        .getAttribute("href"),
    ).toBe("/app/settings/api-keys");
    for (const moduleName of [
      "Usuários|Users",
      "Grupos|Groups",
      "Webhooks",
      "Plugins",
      "Auditoria|Audit",
    ])
      expect(
        screen.getByRole("link", { name: new RegExp(moduleName) }),
      ).toBeTruthy();

    const search = screen.getByRole("textbox", {
      name: /Buscar módulos e plugins|Search modules and plugins/,
    });
    fireEvent.change(search, { target: { value: "contas" } });

    expect(screen.queryByRole("link", { name: /CRM/ })).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Chaves de API|API keys/ }),
    ).toBeNull();
    expect(screen.getByRole("link", { name: /Meta Ads/ })).toBeTruthy();

    fireEvent.change(search, { target: { value: "api-keys" } });

    expect(
      screen.getByRole("link", { name: /Chaves de API|API keys/ }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Meta Ads/ })).toBeNull();
  });

  it("loads each user's saved module and plugin order", async () => {
    ability.update([{ action: "manage", subject: "all" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me/overview-preference"))
          return Response.json({
            config: {
              version: 1,
              itemOrder: ["plugin.crm", "core.groups", "core.users"],
            },
            updatedAt: 123,
          });
        return Response.json({
          plugins: [
            {
              pluginId: "crm",
              name: "CRM",
              menu: [{ title: "CRM", routeKey: "crm.home" }],
            },
          ],
        });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <MemoryRouter>
            <DashboardPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );

    await screen.findByRole("link", { name: /CRM/ });
    const links = screen.getAllByRole("link");
    expect(links[0]?.textContent).toContain("CRM");
    expect(links[1]?.textContent).toMatch(/Grupos|Groups/);
    expect(
      screen.getByRole("button", { name: /Arrastar CRM|Drag CRM/ }),
    ).toBeTruthy();
  });
});
