/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "../frontend/src/features/dashboard.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Overview plugin navigation", () => {
  it("lists every permitted installed plugin and searches all of its menu entries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
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
        }),
      ),
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
      (await screen.findByRole("link", { name: /CRM/ })).getAttribute("href"),
    ).toBe("/app/crm");
    expect(
      screen.getByRole("link", { name: /Meta Ads/ }).getAttribute("href"),
    ).toBe("/app/meta-ads");

    fireEvent.change(
      screen.getByRole("textbox", { name: /Buscar plugins|Search plugins/ }),
      { target: { value: "contas" } },
    );

    expect(screen.queryByRole("link", { name: /CRM/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Meta Ads/ })).toBeTruthy();
  });
});
