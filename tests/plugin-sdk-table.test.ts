// @vitest-environment jsdom

import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginHostV1 } from "../packages/plugin-sdk/src/index.js";
import { mountConfigurableDataTable } from "../packages/plugin-sdk/src/table.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("public plugin SDK configurable table", () => {
  it("hydrates per-user preferences and keeps settings in the Actions header", async () => {
    vi.useFakeTimers();
    const set = vi.fn(async () => undefined);
    const host = {
      apiVersion: 1,
      pluginId: "outside",
      locale: "en",
      theme: "light",
      permissions: [],
      api: vi.fn(),
      coreApi: vi.fn(),
      navigate: vi.fn(),
      notify: vi.fn(),
      tablePreferences: {
        get: vi.fn(async () => ({
          version: 1,
          columnOrder: ["name", "id"],
          columnVisibility: { id: true, name: true },
          columnSizing: { id: 120, name: 220 },
          sorting: [],
        })),
        set,
      },
    } satisfies PluginHostV1;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const opened = vi.fn();
    const mounted = await mountConfigurableDataTable({
      container,
      host,
      tableId: "plugin.outside.records",
      rows: [
        { id: "2", name: "Beta" },
        { id: "1", name: "Alpha" },
      ],
      columns: [
        {
          key: "id",
          label: "ID",
          render: (row) => row.id,
          sortValue: (row) => row.id,
          size: 120,
          minSize: 80,
          maxSize: 200,
        },
        {
          key: "name",
          label: "Name",
          render: (row) => row.name,
          sortValue: (row) => row.name,
          size: 220,
          minSize: 100,
          maxSize: 400,
        },
      ],
      onOpen: opened,
    });
    const headers = [...container.querySelectorAll("th")];
    expect(headers.at(-1)?.textContent).toContain("Actions");
    expect(
      headers.at(-1)?.querySelector("summary")?.getAttribute("aria-label"),
    ).toBe("Columns");
    expect(headers[0]?.textContent).toContain("Name");

    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".nexus-table-sort")!,
    );
    expect(container.querySelector("tbody tr td")?.textContent).toBe("Alpha");
    await vi.advanceTimersByTimeAsync(301);
    expect(set).toHaveBeenCalledWith(
      "plugin.outside.records",
      expect.objectContaining({ sorting: [{ id: "name", desc: false }] }),
    );

    const firstRow = container.querySelector<HTMLTableRowElement>("tbody tr")!;
    fireEvent.keyDown(firstRow, { key: "Enter" });
    expect(opened).toHaveBeenCalledWith({ id: "1", name: "Alpha" });
    mounted.dispose();
  });

  it("rejects table IDs outside the plugin namespace", async () => {
    const host = {
      apiVersion: 1,
      pluginId: "outside",
      locale: "en",
      theme: "light",
      permissions: [],
      api: vi.fn(),
      coreApi: vi.fn(),
      navigate: vi.fn(),
      notify: vi.fn(),
      tablePreferences: { get: vi.fn(), set: vi.fn() },
    } satisfies PluginHostV1;
    await expect(
      mountConfigurableDataTable({
        container: document.createElement("div"),
        host,
        tableId: "core.records",
        rows: [],
        columns: [],
        onOpen: vi.fn(),
      }),
    ).rejects.toThrow("Table ID must start with plugin.outside.");
  });

  it("keeps the configurable Actions header in the empty state", async () => {
    const host = {
      apiVersion: 1,
      pluginId: "outside",
      locale: "en",
      theme: "light",
      permissions: [],
      api: vi.fn(),
      coreApi: vi.fn(),
      navigate: vi.fn(),
      notify: vi.fn(),
      tablePreferences: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
      },
    } satisfies PluginHostV1;
    const container = document.createElement("div");
    await mountConfigurableDataTable({
      container,
      host,
      tableId: "plugin.outside.empty",
      rows: [],
      columns: [
        {
          key: "id",
          label: "ID",
          render: (row: { id: string }) => row.id,
          sortValue: (row) => row.id,
          size: 120,
          minSize: 80,
          maxSize: 200,
        },
      ],
      onOpen: vi.fn(),
    });
    expect(
      container.querySelector("thead th:last-child")?.textContent,
    ).toContain("Actions");
    expect(container.querySelector("tbody")?.textContent).toContain(
      "No records found.",
    );
  });
});
