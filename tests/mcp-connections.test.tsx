/* @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageSwitcher } from "../frontend/src/components/i18n/LanguageSwitcher.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";
import McpPage from "../frontend/src/features/mcp/McpPage.js";
import McpAuthorizePage from "../frontend/src/features/mcp/McpAuthorizePage.js";

const clients: QueryClient[] = [];
function mount(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <I18nProvider>
        <LanguageSwitcher />
        <MemoryRouter>{children}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "pt-BR" },
  });
}
const connection = () => ({
  id: "test-connection",
  name: "Test assistant",
  createdAt: Date.now(),
  authorizedActionCount: 0,
  availableActionCount: 2,
  needsPermissionUpdate: true,
});
const actions = [
  {
    name: "demo_read",
    title: "Read",
    titles: { "pt-BR": "Consultar registros" },
    destructive: false,
  },
  {
    name: "demo_delete",
    title: "Delete",
    titles: { "pt-BR": "Excluir registros" },
    destructive: true,
  },
];
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MCP connection consent review", () => {
  it("enables automatic sync in one click, persists it across reloads and allows returning to manual mode", async () => {
    let stored = {
      ...connection(),
      authorizedActionCount: 2,
      needsPermissionUpdate: false,
      autoSyncActions: false,
    };
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/test-connection/permissions")) {
          const body = JSON.parse(String(init?.body));
          writes.push(body);
          stored = { ...stored, autoSyncActions: body.autoSyncActions };
          return Response.json(stored);
        }
        return Response.json(
          path.endsWith("/mcp-connections")
            ? { items: [stored], actions }
            : { config: null },
        );
      }),
    );
    mount(<McpPage />);
    fireEvent.click(await screen.findByRole("row", { name: /Test assistant/ }));
    let dialog = within(screen.getByRole("dialog"));
    fireEvent.click(
      dialog.getByRole("switch", { name: "Sincronizar ações automaticamente" }),
    );
    await waitFor(() =>
      expect(dialog.getByRole("switch").getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(
      dialog.queryByRole("button", { name: "Atualizar permissões" }),
    ).toBeNull();
    expect(dialog.getByRole("status").textContent).toContain(
      "Tudo certo no Nexus",
    );
    expect(writes).toEqual([
      { approvedActions: ["demo_read", "demo_delete"], autoSyncActions: true },
    ]);
    cleanup();
    mount(<McpPage />);
    fireEvent.click(await screen.findByRole("row", { name: /Test assistant/ }));
    dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("switch").getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(dialog.getByRole("switch"));
    await waitFor(() =>
      expect(dialog.getByRole("switch").getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(
      dialog.getByRole("button", { name: "Atualizar permissões" }),
    ).toBeDefined();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      approvedActions: ["demo_read", "demo_delete"],
      autoSyncActions: false,
    });
  });

  it("keeps manual mode when automatic consent cannot be saved", async () => {
    const stored = { ...connection(), autoSyncActions: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/test-connection/permissions"))
          return Response.json(
            { error: { code: "MCP_CONSENT_CHANGED" } },
            { status: 409 },
          );
        return Response.json(
          path.endsWith("/mcp-connections")
            ? { items: [stored], actions }
            : { config: null },
        );
      }),
    );
    mount(<McpPage />);
    fireEvent.click(await screen.findByRole("row", { name: /Test assistant/ }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(dialog.getByRole("switch"));
    await dialog.findByRole("alert");
    expect(dialog.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(dialog.getByRole("status").textContent).toContain(
      "Revise e atualize",
    );
  });

  it("clearly offers future-action consent at initial login and submits the user's choice", async () => {
    const writes: Array<{ autoSyncActions: boolean }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/mcp/oauth/authorize")) {
          writes.push(JSON.parse(String(init?.body)));
          return Response.json(
            { error: { code: "MCP_CONSENT_CHANGED" } },
            { status: 409 },
          );
        }
        return Response.json({
          clientName: "Test assistant",
          redirectOrigin: "https://assistant.example",
          actions,
        });
      }),
    );
    mount(<McpAuthorizePage />);
    const checkbox = await screen.findByRole("checkbox", {
      name: /Sincronizar ações automaticamente/,
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/agora e no futuro/)).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Autorizar", exact: true }),
    );
    await screen.findByRole("alert");
    expect(writes[0]?.autoSyncActions).toBe(true);
    fireEvent.click(checkbox);
    fireEvent.click(
      screen.getByRole("button", { name: "Autorizar", exact: true }),
    );
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]?.autoSyncActions).toBe(false);
  });

  it("shows the zero-scope mismatch and updates only the selected connection after reviewing its actions", async () => {
    let stored = connection();
    const writes: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/test-connection/permissions")) {
          expect(init?.method).toBe("POST");
          writes.push(JSON.parse(String(init.body)));
          stored = {
            ...stored,
            authorizedActionCount: 2,
            needsPermissionUpdate: false,
          };
          return Response.json(stored);
        }
        return Response.json(
          path.endsWith("/mcp-connections")
            ? { items: [stored], actions }
            : { config: null },
        );
      }),
    );
    mount(<McpPage />);
    expect(await screen.findByText("0 de 2 ações autorizadas")).toBeDefined();
    expect(writes).toEqual([]);
    fireEvent.click(screen.getByRole("row", { name: /Test assistant/ }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Consultar registros")).toBeDefined();
    expect(dialog.getByText("Excluir registros")).toBeDefined();
    expect(dialog.getByText(/Esta ação pode excluir/)).toBeDefined();
    expect(writes).toEqual([]);
    fireEvent.click(
      dialog.getByRole("button", { name: "Atualizar permissões" }),
    );
    await waitFor(() =>
      expect(
        (
          dialog.getByRole("button", {
            name: "Atualizar permissões",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true),
    );
    await waitFor(() =>
      expect(dialog.getByRole("status").textContent).toContain(
        "Permissões atualizadas",
      ),
    );
    expect(writes).toEqual([{ approvedActions: ["demo_read", "demo_delete"] }]);
    expect(dialog.getByText("2 de 2 ações autorizadas")).toBeDefined();
  });

  it("preserves the old authorization and shows a useful error when the reviewed actions changed", async () => {
    const stored = connection();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/test-connection/permissions"))
          return Response.json(
            { error: { code: "MCP_CONSENT_CHANGED" } },
            { status: 409 },
          );
        return Response.json(
          path.endsWith("/mcp-connections")
            ? { items: [stored], actions }
            : { config: null },
        );
      }),
    );
    mount(<McpPage />);
    fireEvent.click(await screen.findByRole("row", { name: /Test assistant/ }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.click(
      dialog.getByRole("button", { name: "Atualizar permissões" }),
    );
    expect((await dialog.findByRole("alert")).textContent).toContain(
      "As ações disponíveis mudaram",
    );
    expect(dialog.getByText("0 de 2 ações autorizadas")).toBeDefined();
    expect(dialog.getByRole("status").textContent).toContain(
      "Revise e atualize",
    );
  });

  it("does not allow approving an empty initial connection", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        clientName: "Test assistant",
        redirectOrigin: "https://assistant.example",
        actions: [],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    mount(<McpAuthorizePage />);
    const authorize = await screen.findByRole("button", {
      name: "Autorizar",
      exact: true,
    });
    expect((authorize as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Nenhuma ação está liberada/)).toBeDefined();
    fireEvent.click(authorize);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
