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
  it("does not open a row while the user is selecting text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ tableId: "core.users", config: null, updatedAt: null }),
      ),
    );
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Alice",
    } as Selection);
    const onOpen = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ConfigurableDataTable
            tableId="core.users"
            rows={[{ id: "1", name: "Alice", email: "alice@example.com" }]}
            onOpen={onOpen}
            columns={[
              {
                key: "name",
                label: "Name",
                size: 200,
                minSize: 80,
                maxSize: 800,
                render: (row) => row.name,
                sortValue: (row) => row.name,
              },
            ]}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    fireEvent.click((await screen.findByText("Alice")).closest("tr")!);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reports controlled sorting without reordering a server-sorted page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          tableId: "plugin.meeting_recorder.recordings",
          config: null,
          updatedAt: null,
        }),
      ),
    );
    const onSortingChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <ConfigurableDataTable
            tableId="plugin.meeting_recorder.recordings"
            rows={[
              { id: "1", name: "Bob", email: "bob@example.com" },
              { id: "2", name: "Alice", email: "alice@example.com" },
            ]}
            sorting={[]}
            onSortingChange={onSortingChange}
            manualSorting
            onOpen={() => undefined}
            columns={[
              {
                key: "name",
                label: "Name",
                size: 200,
                minSize: 80,
                maxSize: 800,
                render: (row) => row.name,
                sortValue: (row) => row.name,
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
    expect(onSortingChange).toHaveBeenLastCalledWith([
      { id: "name", desc: false },
    ]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]?.textContent).toContain("Bob");
    expect(rows[1]?.textContent).toContain("Alice");
  });

  it("keeps working without persistence when an older Core returns 404", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(init?.method ?? "GET");
        return Response.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 },
        );
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    render(
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
                maxSize: 800,
                render: (row) => row.name,
                sortValue: (row) => row.name,
              },
            ]}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Alice")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: /(ordenar|sort) name/i }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    expect(requests).toEqual(["GET"]);
  });

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
                maxSize: 800,
                render: (row) => row.name,
                sortValue: (row) => row.name,
              },
              {
                key: "email",
                label: "Email",
                size: 220,
                minSize: 80,
                maxSize: 800,
                render: (row) => row.email,
                sortValue: (row) => row.email,
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
                size: 180,
                minSize: 80,
                maxSize: 600,
              },
              {
                key: "email",
                label: "Email",
                sortValue: (row) => row.email,
                render: (row) => row.email,
                size: 240,
                minSize: 120,
                maxSize: 800,
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
    expect(
      bodyRows.every((row) => row.classList.contains("app-table-row")),
    ).toBe(true);
    expect(
      screen
        .getByRole("table")
        .parentElement?.classList.contains("app-table-shell"),
    ).toBe(true);
    expect(
      screen
        .getByRole("columnheader", { name: /name/i })
        .closest("thead")
        ?.classList.contains("app-table-head"),
    ).toBe(true);
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
  it("resizes pinned Actions independently, persists, reloads and resets its width", async () => {
    let stored: unknown = null;
    const requests: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (init?.method === "PUT") {
          stored = JSON.parse(String(init.body));
          requests.push(stored);
        }
        if (init?.method === "DELETE") stored = null;
        return Response.json({
          tableId: "core.action-test",
          config: stored,
          updatedAt: null,
        });
      }),
    );
    const onOpen = vi.fn(),
      action = vi.fn();
    const mount = () =>
      render(
        <QueryClientProvider
          client={
            new QueryClient({
              defaultOptions: {
                queries: { retry: false },
                mutations: { retry: false },
              },
            })
          }
        >
          <I18nProvider>
            <ConfigurableDataTable
              tableId="core.action-test"
              rows={[{ id: "1", name: "Alice" }]}
              onOpen={onOpen}
              columns={[
                {
                  key: "name",
                  label: "Name",
                  render: (r) => r.name,
                  sortValue: (r) => r.name,
                  size: 200,
                  minSize: 80,
                  maxSize: 800,
                },
              ]}
              actions={() => (
                <div>
                  <button onClick={action}>Edit</button>
                  <button>Pause</button>
                  <button>End</button>
                </div>
              )}
            />
          </I18nProvider>
        </QueryClientProvider>,
      );
    let mounted = mount();
    await screen.findByRole("table");
    let cols = mounted.container.querySelectorAll("col");
    expect(cols[1]?.style.width).toBe("240px");
    let handle = screen.getByRole("separator", {
      name: /Redimensionar coluna Ações|Resize Actions column/,
    });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(cols[1]?.style.width).toBe("250px");
    expect(cols[0]?.style.width).toBe("200px");
    // jsdom needs an explicit PointerEvent implementation for pointer coordinates.
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      return event;
    };
    fireEvent(handle, pointer("pointerdown", 500));
    fireEvent(document, pointer("pointermove", 400));
    expect(cols[1]?.style.width).toBe("350px");
    fireEvent(document, pointer("pointerup", 380));
    expect(cols[1]?.style.width).toBe("370px");
    fireEvent(document, pointer("pointermove", 700));
    expect(cols[1]?.style.width).toBe("370px");
    expect(cols[0]?.style.width).toBe("200px");
    await waitFor(() => expect(requests.length).toBeGreaterThan(0));
    expect(stored).toMatchObject({
      columnSizing: { name: 200, __nexus_actions: 370 },
      columnOrder: ["name"],
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Edit" }), {
      key: "Enter",
    });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(action).toHaveBeenCalledTimes(1);
    mounted.unmount();
    mounted = mount();
    await screen.findByRole("table");
    cols = mounted.container.querySelectorAll("col");
    expect(cols[1]?.style.width).toBe("370px");
    handle = screen.getByRole("separator", {
      name: /Redimensionar coluna Ações|Resize Actions column/,
    });
    fireEvent.keyDown(handle, { key: "Home" });
    expect(cols[1]?.style.width).toBe("144px");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(cols[1]?.style.width).toBe("144px");
    fireEvent.keyDown(handle, { key: "End" });
    expect(cols[1]?.style.width).toBe("640px");
    const settings = screen.getByRole("button", {
      name: /^(Colunas|Columns)$/,
    });
    expect(settings.closest("th")?.dataset.columnKey).toBe("__nexus_actions");
    fireEvent.pointerDown(settings, { button: 0, ctrlKey: false });
    fireEvent.click(
      screen.getByRole("button", { name: /Restaurar padrão|Restore defaults/ }),
    );
    await waitFor(() => expect(cols[1]?.style.width).toBe("240px"));
  });
});
