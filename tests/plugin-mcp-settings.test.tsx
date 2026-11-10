/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import { LanguageSwitcher } from "../frontend/src/components/i18n/LanguageSwitcher.js";
import { PluginMcpSettings } from "../frontend/src/features/plugins/PluginMcpSettings.js";
import { ability } from "../frontend/src/lib/ability.js";

const initialSettings = () => ({
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
});
type Selection = { enabled: boolean; allowedActions: string[] };
function mockServer(
  stored = initialSettings(),
  put?: (input: Selection) => Promise<Response>,
) {
  const writes: Selection[] = [];
  const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as Selection;
      writes.push(body);
      if (put) return put(body);
      stored = { ...stored, ...body };
    }
    return Response.json(stored);
  });
  vi.stubGlobal("fetch", fetch);
  return { writes, fetch, stored: () => stored };
}
const clients: QueryClient[] = [];
function mount(pluginId = "demo") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const locale = localStorage.getItem("modular.language") ?? "pt-BR";
  const view = render(<PluginMcpSettings pluginId={pluginId} />, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <I18nProvider>
          <LanguageSwitcher />
          <MemoryRouter>{children}</MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    ),
  });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: locale } });
  return { client, ...view };
}
const saveButton = () =>
  screen.getByRole("button", {
    name: "Salvar",
    exact: true,
  }) as HTMLButtonElement;
const checkboxes = () => screen.getAllByRole("checkbox") as HTMLInputElement[];
const waitForSaved = () =>
  waitFor(() => {
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain(
      "Escolha as ações",
    );
  });
beforeEach(() => {
  localStorage.setItem("modular.language", "pt-BR");
  ability.update([{ action: "manage", subject: "all" }]);
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  ability.update([]);
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("plugin MCP controls", () => {
  it("edits activation and actions locally, then persists everything in one request across reloads", async () => {
    const server = mockServer();
    mount();
    const toggle = await screen.findByRole("switch");
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(checkboxes()[0]!);
    fireEvent.click(checkboxes()[1]!);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(checkboxes().every((input) => input.checked)).toBe(true);
    expect(server.writes).toEqual([]);
    expect(server.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("não salvas");
    fireEvent.click(saveButton());
    await waitForSaved();
    expect(server.writes).toEqual([
      { enabled: true, allowedActions: ["demo_list", "demo_delete"] },
    ]);
    expect(server.fetch).toHaveBeenCalledTimes(2);
    cleanup();
    mount();
    expect(
      (await screen.findByRole("switch")).getAttribute("aria-checked"),
    ).toBe("true");
    expect(checkboxes().every((input) => input.checked)).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("selects and deselects all immediately and allows adjusting the selection before saving", async () => {
    const server = mockServer();
    mount();
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
    expect(checkboxes().every((input) => input.checked)).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Marcar todas",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todas" }));
    expect(checkboxes().every((input) => !input.checked)).toBe(true);
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
    fireEvent.click(checkboxes()[1]!);
    expect(server.writes).toEqual([]);
    expect(server.fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(saveButton());
    await waitForSaved();
    expect(server.writes).toEqual([
      { enabled: false, allowedActions: ["demo_list"] },
    ]);
  });

  it("persists deselecting all only when Save is clicked", async () => {
    const server = mockServer({
      ...initialSettings(),
      enabled: true,
      allowedActions: ["demo_list", "demo_delete"],
    });
    mount();
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "Desmarcar todas" }));
    expect(checkboxes().every((input) => !input.checked)).toBe(true);
    expect(server.stored().allowedActions).toEqual([
      "demo_list",
      "demo_delete",
    ]);
    expect(server.writes).toEqual([]);
    fireEvent.click(saveButton());
    await waitForSaved();
    expect(server.writes).toEqual([{ enabled: true, allowedActions: [] }]);
  });

  it("discards the draft without sending a request", async () => {
    const server = mockServer();
    mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Marcar todas" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Descartar alterações" }),
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(checkboxes().every((input) => !input.checked)).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(server.fetch).toHaveBeenCalledTimes(1);
  });

  it("disables controls during a save, preserves the draft on failure, and allows retrying", async () => {
    let completeSave: ((response: Response) => void) | undefined;
    const server = mockServer(
      initialSettings(),
      () =>
        new Promise<Response>((resolve) => {
          completeSave = resolve;
        }),
    );
    const { client } = mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(checkboxes()[0]!);
    fireEvent.click(saveButton());
    const saving = await screen.findByRole("button", { name: "Salvando…" });
    expect((saving as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(checkboxes()[0]!.closest("fieldset")?.disabled).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Descartar alterações",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    completeSave!(
      Response.json(
        { error: { code: "INTERNAL_ERROR", message: "Save failed" } },
        { status: 500 },
      ),
    );
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(checkboxes()[0]!.checked).toBe(true);
    expect(client.getQueryData(["plugin-mcp", "demo"])).toEqual(
      initialSettings(),
    );
    expect(screen.getByRole("status").textContent).toContain("não salvas");
    fireEvent.click(saveButton());
    await waitFor(() => expect(server.writes).toHaveLength(2));
    completeSave!(
      Response.json({
        ...initialSettings(),
        enabled: true,
        allowedActions: ["demo_list"],
      }),
    );
    await waitForSaved();
    expect(checkboxes()[0]!.checked).toBe(true);
    expect(screen.getByRole("status").textContent).not.toContain("não salvas");
  });

  it("keeps unsaved choices when settings refetch in the background", async () => {
    const server = mockServer();
    const { client } = mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(checkboxes()[0]!);
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["plugin-mcp", "demo"] });
    });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(checkboxes()[0]!.checked).toBe(true);
    expect(server.writes).toEqual([]);
    expect(saveButton().disabled).toBe(false);
  });

  it("does not carry unsaved choices to another plugin", async () => {
    const server = mockServer();
    const { rerender } = mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(checkboxes()[0]!);
    rerender(<PluginMcpSettings pluginId="another" />);
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(checkboxes().every((input) => !input.checked)).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(server.writes).toEqual([]);
  });

  it("keeps the draft available when a background refetch fails", async () => {
    const server = mockServer();
    const { client } = mount();
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(checkboxes()[0]!);
    server.fetch.mockResolvedValueOnce(
      Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 }),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["plugin-mcp", "demo"] });
    });
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(checkboxes()[0]!.checked).toBe(true);
    expect(saveButton().disabled).toBe(false);
    expect(server.writes).toEqual([]);
    fireEvent.click(saveButton());
    await waitForSaved();
    expect(server.writes).toEqual([
      { enabled: true, allowedActions: ["demo_list"] },
    ]);
  });

  it("disables activation, bulk selection and saving without plugin-update permission", async () => {
    ability.update([]);
    mockServer();
    mount();
    expect(
      ((await screen.findByRole("switch")) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(checkboxes()[0]!.closest("fieldset")?.disabled).toBe(true);
    expect(
      screen.getByRole("button", { name: "Marcar todas" }).matches(":disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Desmarcar todas" })
        .matches(":disabled"),
    ).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("does not allow enabling plugins with no declared actions", async () => {
    mockServer({ ...initialSettings(), actions: [] });
    mount();
    expect(
      ((await screen.findByRole("switch")) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar todas" })).toBeNull();
    expect(saveButton().disabled).toBe(true);
  });

  it("translates the bulk controls and save workflow into English", async () => {
    localStorage.setItem("modular.language", "en");
    const server = mockServer();
    mount();
    await screen.findByRole("switch");
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByRole("button", { name: "Deselect all" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Discard changes" }),
    ).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("unsaved changes");
    fireEvent.click(screen.getByRole("button", { name: "Save", exact: true }));
    await waitFor(() => expect(server.writes).toHaveLength(1));
  });
});
