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
