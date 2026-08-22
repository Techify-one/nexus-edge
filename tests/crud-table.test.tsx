/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "../frontend/src/components/ui/data-table.js";
import { I18nProvider } from "../frontend/src/i18n/index.js";

type Row = { id: string; name: string };
const rows: Row[] = [
  { id: "1", name: "Alice" },
  { id: "2", name: "Bob" },
];

afterEach(cleanup);

const renderTable = (table: React.ReactNode) =>
  render(<I18nProvider>{table}</I18nProvider>);

describe("CRUD visual contract", () => {
  it("renders exactly one row per record", () => {
    renderTable(
      <DataTable
        rows={rows}
        columns={[{ key: "name", label: "Name", render: (row) => row.name }]}
        onOpen={() => undefined}
      />,
    );

    expect(screen.getAllByRole("row")).toHaveLength(rows.length + 1);
    expect(screen.getByRole("table").classList.contains("table-fixed")).toBe(
      true,
    );
    expect(
      screen.getByText("Alice").closest("td")?.classList.contains("truncate"),
    ).toBe(true);
  });

  it("opens a record by click, Enter, or Space", () => {
    const onOpen = vi.fn();
    renderTable(
      <DataTable
        rows={rows}
        columns={[{ key: "name", label: "Name", render: (row) => row.name }]}
        onOpen={onOpen}
      />,
    );

    const alice = screen.getByText("Alice").closest("tr");
    expect(alice).not.toBeNull();
    fireEvent.click(alice!);
    fireEvent.keyDown(alice!, { key: "Enter" });
    fireEvent.keyDown(alice!, { key: " " });
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenLastCalledWith(rows[0]);
  });

  it("does not open a record when a row action is used", () => {
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    renderTable(
      <DataTable
        rows={rows}
        columns={[{ key: "name", label: "Name", render: (row) => row.name }]}
        onOpen={onOpen}
        actions={(row) => (
          <button type="button" onClick={() => onEdit(row)}>
            Edit {row.name}
          </button>
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Alice" }));
    expect(onEdit).toHaveBeenCalledWith(rows[0]);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
