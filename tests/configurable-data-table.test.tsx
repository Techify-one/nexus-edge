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
import { ConfigurableDataTable } from "../frontend/src/components/ui/configurable-data-table.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";

type Row = { id: string; name: string; email: string };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("configurable data table", () => {
  it("resizes one column continuously and stops at the mouse release position", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET")
          return new Response(
            JSON.stringify({
              tableId: "core.users",
              config: null,
              updatedAt: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        return new Response(
          JSON.stringify({ tableId: "core.users", config: {}, updatedAt: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ConfigurableDataTable
            tableId="core.users"
            rows={[{ id: "1", name: "Alice", email: "alice@example.com" }]}
            onOpen={() => undefined}
            columns={[
              {
                key: "name",
                label: "Name",
                size: 200,
                minSize: 80,
                render: (row) => row.name,
              },
              {
                key: "email",
                label: "Email",
                size: 220,
                minSize: 80,
                render: (row) => row.email,
              },
            ]}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    await screen.findByRole("table");
    const columns = container.querySelectorAll("col");
    const separators = screen.getAllByRole("separator");
    expect(
      screen.getByRole("button", { name: /^(Colunas|Columns)$/ }).closest("th"),
    ).not.toBeNull();
    expect(columns[0]?.style.width).toBe("200px");
    expect(columns[1]?.style.width).toBe("220px");

    fireEvent.mouseDown(separators[0]!, { clientX: 200 });
    fireEvent.mouseMove(document, { clientX: 320 });

    expect(columns[0]?.style.width).toBe("320px");
    expect(columns[1]?.style.width).toBe("220px");

    fireEvent.mouseUp(document, { clientX: 345 });

    expect(columns[0]?.style.width).toBe("345px");
    expect(columns[1]?.style.width).toBe("220px");
  });

  it("sorts and hides columns while persisting a personal preference", async () => {
    const requests: Array<{ method: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push({
          method,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        if (method === "GET")
          return new Response(
            JSON.stringify({
              tableId: "core.users",
              config: null,
              updatedAt: null,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        return new Response(
          JSON.stringify({ tableId: "core.users", config: {}, updatedAt: 1 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const rows: Row[] = [
      { id: "1", name: "Bob", email: "bob@example.com" },
      { id: "2", name: "Alice", email: "alice@example.com" },
    ];

    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ConfigurableDataTable
            tableId="core.users"
            rows={rows}
            onOpen={() => undefined}
            actions={() => null}
            columns={[
              {
                key: "name",
                label: "Name",
                sortValue: (row) => row.name,
                render: (row) => row.name,
              },
              {
                key: "email",
                label: "Email",
                sortValue: (row) => row.email,
                render: (row) => row.email,
              },
            ]}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    await screen.findByRole("table");
    fireEvent.click(
      screen.getByRole("button", { name: /(ordenar|sort) name/i }),
    );
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(bodyRows[0]?.textContent).toContain("Alice");
    expect(bodyRows[1]?.textContent).toContain("Bob");

    const columnsButton = screen.getByRole("button", {
      name: /^(Colunas|Columns)$/,
    });
    expect(columnsButton.closest("th")).not.toBeNull();
    expect(screen.queryByText(/^(Colunas|Columns)$/)).toBeNull();
    fireEvent.pointerDown(columnsButton, { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("checkbox", { name: "Email" }));
    expect(screen.queryByText("bob@example.com")).toBeNull();

    await waitFor(
      () => expect(requests.some(({ method }) => method === "PUT")).toBe(true),
      { timeout: 1_500 },
    );
    const saved = requests.findLast(({ method }) => method === "PUT");
    expect(JSON.parse(saved?.body ?? "{}")).toMatchObject({
      columnVisibility: { email: false },
      sorting: [{ id: "name", desc: false }],
    });
  });
});
