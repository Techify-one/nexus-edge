/* @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "../frontend/src/features/dashboard.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { ability } from "../frontend/src/lib/ability.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ability.update([]);
});

describe("Overview navigation persistence", () => {
  it("keeps the latest order when navigating away and back without a reload", async () => {
    ability.update([{ action: "manage", subject: "all" }]);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        const labels = [
          "Users",
          "Groups",
          "API keys",
          "Webhooks",
          "Plugins",
          "Audit",
        ];
        const index = labels.findIndex((label) =>
          (this.textContent ?? "").startsWith(label),
        );
        return DOMRect.fromRect({
          x: Math.max(index, 0) * 100,
          y: 0,
          width: 80,
          height: 80,
        });
      },
    );
    const savedOrders: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/me/overview-preference")) {
          if (init?.method === "PUT") {
            const config = JSON.parse(String(init.body)) as {
              version: 1;
              itemOrder: string[];
            };
            savedOrders.push(config.itemOrder);
            return Response.json({ config, updatedAt: 456 });
          }
          return Response.json({ config: null, updatedAt: null });
        }
        return Response.json({ plugins: [] });
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 15_000 },
        mutations: { retry: false },
      },
    });
    const view = () =>
      render(
        <QueryClientProvider client={queryClient}>
          <I18nProvider>
            <MemoryRouter>
              <DashboardPage />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );

    view();
    await screen.findByRole("link", { name: /Usuários|Users/ });
    const dragUsers = screen.getByRole("button", {
      name: /Arrastar Usuários|Drag Users/,
    });
    fireEvent.keyDown(dragUsers, { key: " ", code: "Space" });
    await waitFor(() =>
      expect(dragUsers.getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.keyDown(dragUsers, { key: "ArrowRight", code: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("core.groups"),
    );
    fireEvent.keyDown(dragUsers, { key: " ", code: "Space" });
    cleanup();
    view();

    await screen.findByRole("link", { name: /Grupos|Groups/ });
    const links = screen.getAllByRole("link");
    expect(links[0]?.textContent).toMatch(/Grupos|Groups/);
    expect(links[1]?.textContent).toMatch(/Usuários|Users/);
    await waitFor(() => expect(savedOrders).toHaveLength(1));
    expect(savedOrders[0]?.slice(0, 2)).toEqual(["core.groups", "core.users"]);
  });
});
