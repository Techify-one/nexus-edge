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
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { PluginMcpSettings } from "../frontend/src/features/plugins/PluginMcpSettings.js";
import { ability } from "../frontend/src/lib/ability.js";

afterEach(() => {
  cleanup();
  ability.update([]);
  vi.restoreAllMocks();
});
describe("plugin MCP controls", () => {
  it("persists activation and individual actions, including after a fresh page load", async () => {
    ability.update([{ action: "manage", subject: "all" }]);
    const writes: unknown[] = [];
    let stored = {
      enabled: false,
      allowedActions: [] as string[],
      endpoint: "https://hub.example/mcp",
      actions: [
        {
          name: "demo_list",
          title: "List records",
          titles: { "pt-BR": "Listar registros", en: "List records" },
          destructive: false,
        },
        { name: "demo_delete", title: "Delete records", destructive: true },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          stored = { ...stored, ...body };
        }
        return Response.json(stored);
      }),
    );
    const mount = () =>
      render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <I18nProvider>
            <MemoryRouter>
              <PluginMcpSettings pluginId="demo" />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>,
      );
    mount();
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    await waitFor(() =>
      expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]!);
    await waitFor(() => expect(stored.allowedActions).toEqual(["demo_list"]));
    expect(writes).toEqual([
      { enabled: true, allowedActions: [] },
      { enabled: true, allowedActions: ["demo_list"] },
    ]);
    cleanup();
    mount();
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(
      (screen.getAllByRole("checkbox")[0] as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getAllByRole("checkbox")[1] as HTMLInputElement).checked,
    ).toBe(false);
  });
  it("disables configuration without plugin-update permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          enabled: false,
          allowedActions: [],
          actions: [
            { name: "demo_list", title: "List records", destructive: false },
          ],
        }),
      ),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider>
          <MemoryRouter>
            <PluginMcpSettings pluginId="demo" />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(
      ((await screen.findByRole("switch")) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("checkbox") as HTMLInputElement).closest("fieldset")
        ?.disabled,
    ).toBe(true);
  });
  it("shows changes immediately and restores the saved state when saving fails", async () => {
    ability.update([{ action: "manage", subject: "all" }]);
    let completeSave: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "PUT")
          return new Promise<Response>((resolve) => {
            completeSave = resolve;
          });
        return Response.json({
          enabled: false,
          allowedActions: [],
          actions: [
            { name: "demo_list", title: "List records", destructive: false },
          ],
        });
      }),
    );
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { mutations: { retry: false } } })
        }
      >
        <I18nProvider>
          <MemoryRouter>
            <PluginMcpSettings pluginId="demo" />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("true"),
    );
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    completeSave!(
      Response.json(
        { error: { code: "INTERNAL_ERROR", message: "Save failed" } },
        { status: 500 },
      ),
    );
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    await waitFor(() =>
      expect((toggle as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
