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
import GeneralSettingsPage from "../frontend/src/features/settings/GeneralSettingsPage.js";
import DashboardPage from "../frontend/src/features/dashboard.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ability } from "../frontend/src/lib/ability.js";
import { MemoryRouter } from "react-router-dom";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  ability.update([]);
});

describe("Home card preference", () => {
  it("saves the switch per user while keeping the existing card order", async () => {
    ability.update([{ action: "manage", subject: "all" }]);
    const saved = {
      version: 1 as const,
      itemOrder: ["plugin.crm", "core.users"],
      showCoreCards: false,
    };
    const writes: (typeof saved)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/settings/general"))
          return Response.json({
            currentVersion: "1.0",
            provider: "d1",
            channel: "beta",
            supported: true,
            credentialConfigured: false,
            updateAvailable: false,
            latest: null,
            activeOperation: null,
          });
        if (url.endsWith("/api/v1/me/overview-preference")) {
          if (init?.method === "PUT") {
            const config = JSON.parse(String(init.body)) as typeof saved;
            writes.push(config);
            Object.assign(saved, config);
          }
          return Response.json({ config: saved, updatedAt: 123 });
        }
        return Response.json({
          plugins: [
            {
              pluginId: "crm",
              name: "CRM",
              menu: [
                { title: "CRM", routeKey: "crm.home", path: "/app/p/crm" },
              ],
            },
          ],
        });
      }),
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const view = (page: "settings" | "dashboard") =>
      render(
        <QueryClientProvider client={client}>
          <I18nProvider>
            <MemoryRouter>
              {page === "settings" ? (
                <GeneralSettingsPage />
              ) : (
                <DashboardPage />
              )}
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );

    view("settings");
    const toggle = await screen.findByRole("switch", {
      name: /Mostrar menus do sistema como cards|Show system menus as cards/,
    });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect(writes[0]).toEqual({
      version: 1,
      itemOrder: ["plugin.crm", "core.users"],
      showCoreCards: true,
    });

    cleanup();
    view("dashboard");
    expect(
      await screen.findByRole("link", { name: /Usuários|Users/ }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /CRM/ })).toBeTruthy();
  });
});
