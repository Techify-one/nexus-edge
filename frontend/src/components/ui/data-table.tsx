import type { KeyboardEvent, ReactNode } from "react";
import { EmptyState } from "./index.js";
import { useI18n } from "../../i18n/index.js";

export type Column<T> = {
  key: string;
  label: string;
  className?: string;
  render: (row: T) => ReactNode;
};

export function DataTable<T extends { id: string }>({
  rows,
  columns,
  onOpen,
  actions,
  emptyTitle,
  emptyDescription,
}: {
  rows: T[];
  columns: Column<T>[];
  onOpen: (row: T) => void;
  actions?: ((row: T) => ReactNode) | undefined;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  const { t } = useI18n();
  if (!rows.length)
    return (
      <EmptyState
        title={emptyTitle ?? t("common.noRecords")}
        description={emptyDescription ?? t("common.noRecordsDescription")}
      />
    );
  const keyOpen = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(row);
    }
  };
  return (
    <div className="overflow-x-auto rounded-2xl border bg-white shadow-sm">
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`px-4 py-3 ${column.className ?? ""}`}
              >
                {column.label}
              </th>
            ))}
            {actions && (
              <th className="w-28 px-4 py-3 text-right">
                {t("common.actions")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              tabIndex={0}
              onKeyDown={(event) => keyOpen(event, row)}
              onClick={() => onOpen(row)}
              className="h-14 cursor-pointer border-t transition hover:bg-indigo-50/50 focus:bg-indigo-50/50"
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`max-w-0 truncate px-4 py-3 align-middle ${column.className ?? ""}`}
                >
                  {column.render(row)}
                </td>
              ))}
              {actions && (
                <td
                  className="px-4 py-2 text-right"
                  onClick={(event) => event.stopPropagation()}
                >
                  {actions(row)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
