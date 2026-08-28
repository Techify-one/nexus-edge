import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  columnOrderingFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnSizingState,
  type ColumnVisibilityState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  GripVertical,
  LoaderCircle,
  Settings2,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
} from "react";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api/core-client.js";
import { useI18n } from "../../i18n/index.js";
import { EmptyState, Skeleton } from "./index.js";

const configurableTableFeatures = tableFeatures({
  columnOrderingFeature,
  columnVisibilityFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});

/**
 * Column contract for the repository-standard data table.
 * Keep `key` and `tableId` stable because they address per-user preferences.
 */
export type ConfigurableColumn<T> = {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  sortValue: (row: T) => string | number | null | undefined;
  size: number;
  minSize: number;
  maxSize: number;
  hideable?: boolean;
};

export type TablePreferenceConfig = {
  version: 1;
  columnOrder: ColumnOrderState;
  columnVisibility: ColumnVisibilityState;
  columnSizing: ColumnSizingState;
  sorting: SortingState;
};

type PreferenceResponse = {
  tableId: string;
  config: TablePreferenceConfig | null;
  updatedAt: string | number | null;
};

type PreferenceLoad = PreferenceResponse & { supported: boolean };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

const defaultPreference = <T,>(
  columns: ConfigurableColumn<T>[],
): TablePreferenceConfig => ({
  version: 1,
  columnOrder: columns.map((column) => column.key),
  columnVisibility: Object.fromEntries(
    columns.map((column) => [column.key, true]),
  ),
  columnSizing: Object.fromEntries(
    columns.map((column) => [
      column.key,
      clamp(column.size, column.minSize, column.maxSize),
    ]),
  ),
  sorting: [],
});

const normalizedPreference = <T,>(
  stored: TablePreferenceConfig | null | undefined,
  columns: ConfigurableColumn<T>[],
): TablePreferenceConfig => {
  const defaults = defaultPreference(columns);
  if (!stored || stored.version !== 1) return defaults;
  const ids = new Set(defaults.columnOrder);
  const sortable = new Set(columns.map((column) => column.key));
  const storedOrder = stored.columnOrder.filter(
    (id, index, values) => ids.has(id) && values.indexOf(id) === index,
  );
  const columnOrder = [
    ...storedOrder,
    ...defaults.columnOrder.filter((id) => !storedOrder.includes(id)),
  ];
  const columnVisibility = Object.fromEntries(
    columns.map((column) => [
      column.key,
      column.hideable === false
        ? true
        : stored.columnVisibility[column.key] !== false,
    ]),
  );
  if (!Object.values(columnVisibility).some(Boolean))
    columnVisibility[columnOrder[0] ?? ""] = true;
  const columnSizing = Object.fromEntries(
    columns.map((column) => [
      column.key,
      clamp(
        stored.columnSizing[column.key] ??
          defaults.columnSizing[column.key] ??
          180,
        column.minSize,
        column.maxSize,
      ),
    ]),
  );
  const sorting = stored.sorting
    .filter(({ id }) => sortable.has(id))
    .slice(0, 1);
  return {
    version: 1,
    columnOrder,
    columnVisibility,
    columnSizing,
    sorting,
  };
};

function DraggableHeader({
  id,
  label,
  size,
  canSort,
  sortDirection,
  onSort,
  onMouseDownResize,
  onTouchStartResize,
}: {
  id: string;
  label: string;
  size: number;
  canSort: boolean;
  sortDirection: false | "asc" | "desc";
  onSort?: ((event: unknown) => void) | undefined;
  onMouseDownResize: (event: MouseEvent<HTMLDivElement>) => void;
  onTouchStartResize: (event: TouchEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const {
    attributes,
    isDragging,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });
  const sortLabel =
    sortDirection === "asc"
      ? t("table.sortDescending", { name: label })
      : t("table.sortAscending", { name: label });
  const ariaSort =
    sortDirection === "asc"
      ? "ascending"
      : sortDirection === "desc"
        ? "descending"
        : "none";

  return (
    <th
      ref={setNodeRef}
      aria-sort={ariaSort}
      className="relative h-12 select-none border-r border-slate-200 px-2 text-left last:border-r-0"
      style={{
        width: size,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.65 : 1,
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="grid h-8 w-7 shrink-0 cursor-grab place-items-center rounded-md text-slate-400 hover:bg-slate-200 hover:text-slate-600 active:cursor-grabbing"
          aria-label={t("table.dragColumn", { name: label })}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          disabled={!canSort}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left disabled:cursor-default"
          aria-label={canSort ? sortLabel : undefined}
          onClick={onSort}
        >
          <span className="truncate">{label}</span>
          {sortDirection === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : sortDirection === "desc" ? (
            <ArrowDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
          ) : canSort ? (
            <ChevronsUpDown
              className="h-3.5 w-3.5 shrink-0 text-slate-400"
              aria-hidden
            />
          ) : null}
        </button>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        className="absolute inset-y-1 -right-1 z-20 w-2 cursor-col-resize touch-none before:absolute before:inset-y-2 before:left-1/2 before:w-px before:bg-slate-300 hover:before:w-0.5 hover:before:bg-indigo-500"
        onMouseDown={(event) => {
          event.stopPropagation();
          onMouseDownResize(event);
        }}
        onTouchStart={(event) => {
          event.stopPropagation();
          onTouchStartResize(event);
        }}
      />
    </th>
  );
}

/**
 * Standard for every new or migrated record-list table.
 * See docs/DATA-TABLE-STANDARD.md before adding a table implementation.
 */
export function ConfigurableDataTable<T extends { id: string }>({
  tableId,
  rows,
  columns,
  onOpen,
  actions,
  emptyTitle,
  emptyDescription,
  sorting: controlledSorting,
  onSortingChange,
  manualSorting = false,
}: {
  tableId: string;
  rows: T[];
  columns: ConfigurableColumn<T>[];
  onOpen: (row: T) => void;
  actions?: ((row: T) => ReactNode) | undefined;
  emptyTitle?: string;
  emptyDescription?: string;
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  manualSorting?: boolean;
}) {
  const { t } = useI18n();
  const preferenceSignature = columns
    .map(
      (column) =>
        `${column.key}:${column.size}:${column.minSize}:${column.maxSize}:${column.hideable !== false}`,
    )
    .join("|");
  const defaults = useMemo(
    () => defaultPreference(columns),
    // The signature intentionally tracks preference-relevant column metadata.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preferenceSignature],
  );
  const [columnOrder, setColumnOrder] = useState(defaults.columnOrder);
  const [columnVisibility, setColumnVisibility] = useState(
    defaults.columnVisibility,
  );
  const [columnSizing, setColumnSizing] = useState(defaults.columnSizing);
  const [localSorting, setLocalSorting] = useState(defaults.sorting);
  const sorting = controlledSorting ?? localSorting;
  const [hydrated, setHydrated] = useState(false);
  const hydratedTableId = useRef<string | null>(null);
  const skipNextSave = useRef(false);
  const latestConfig = useRef(defaults);
  const shouldFlush = useRef(false);

  const preference = useQuery({
    queryKey: ["table-preference", tableId],
    queryFn: async (): Promise<PreferenceLoad> => {
      try {
        return {
          ...(await api<PreferenceResponse>(
            `/api/v1/me/table-preferences/${encodeURIComponent(tableId)}`,
          )),
          supported: true,
        };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          return {
            tableId,
            config: null,
            updatedAt: null,
            supported: false,
          };
        throw error;
      }
    },
  });
  const { isPending: isSaving, mutate: savePreference } = useMutation({
    mutationFn: (config: TablePreferenceConfig) =>
      api<PreferenceResponse>(
        `/api/v1/me/table-preferences/${encodeURIComponent(tableId)}`,
        { method: "PUT", body: JSON.stringify(config) },
      ),
    onSuccess: (_response, config) => {
      if (JSON.stringify(latestConfig.current) === JSON.stringify(config))
        shouldFlush.current = false;
    },
    onError: () => toast.error(t("table.saveFailed")),
  });
  const resetPreference = useMutation({
    mutationFn: () =>
      api<void>(`/api/v1/me/table-preferences/${encodeURIComponent(tableId)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      skipNextSave.current = true;
      shouldFlush.current = false;
      setColumnOrder(defaults.columnOrder);
      setColumnVisibility(defaults.columnVisibility);
      setColumnSizing(defaults.columnSizing);
      setLocalSorting(defaults.sorting);
      onSortingChange?.(defaults.sorting);
    },
    onError: () => toast.error(t("table.saveFailed")),
  });

  useEffect(() => {
    if (preference.isPending || hydratedTableId.current === tableId) return;
    const normalized = normalizedPreference(preference.data?.config, columns);
    setColumnOrder(normalized.columnOrder);
    setColumnVisibility(normalized.columnVisibility);
    setColumnSizing(normalized.columnSizing);
    setLocalSorting(normalized.sorting);
    onSortingChange?.(normalized.sorting);
    latestConfig.current = normalized;
    hydratedTableId.current = tableId;
    setHydrated(true);
  }, [
    columns,
    onSortingChange,
    preference.data?.config,
    preference.isPending,
    tableId,
  ]);

  const currentConfig = useMemo<TablePreferenceConfig>(
    () => ({
      version: 1,
      columnOrder,
      columnVisibility,
      columnSizing,
      sorting,
    }),
    [columnOrder, columnSizing, columnVisibility, sorting],
  );
  latestConfig.current = currentConfig;

  useEffect(() => {
    if (!hydrated || preference.data?.supported === false) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    shouldFlush.current = true;
    const timer = window.setTimeout(() => savePreference(currentConfig), 300);
    return () => window.clearTimeout(timer);
  }, [currentConfig, hydrated, preference.data?.supported, savePreference]);

  const flushPreference = useCallback(() => {
    if (
      !hydrated ||
      preference.data?.supported === false ||
      !shouldFlush.current
    )
      return;
    void fetch(`/api/v1/me/table-preferences/${encodeURIComponent(tableId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(latestConfig.current),
      keepalive: true,
    });
  }, [hydrated, preference.data?.supported, tableId]);

  useEffect(() => {
    window.addEventListener("pagehide", flushPreference);
    return () => {
      window.removeEventListener("pagehide", flushPreference);
      flushPreference();
    };
  }, [flushPreference]);

  const tableColumns = useMemo<
    ColumnDef<typeof configurableTableFeatures, T>[]
  >(
    () =>
      columns.map((column) => ({
        id: column.key,
        header: column.label,
        accessorFn: column.sortValue,
        cell: ({ row }) => column.render(row.original),
        enableSorting: true,
        enableHiding: column.hideable !== false,
        enableResizing: true,
        size: column.size,
        minSize: column.minSize,
        maxSize: column.maxSize,
        sortFn: "alphanumeric",
      })),
    [columns],
  );

  const table = useTable({
    features: configurableTableFeatures,
    data: rows,
    columns: tableColumns,
    getRowId: (row) => row.id,
    state: { columnOrder, columnVisibility, columnSizing, sorting },
    onColumnOrderChange: setColumnOrder,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setLocalSorting(next);
      onSortingChange?.(next);
    },
    manualSorting,
    columnResizeMode: "onChange",
    enableMultiSort: false,
    maxMultiSortColCount: 1,
  });

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setColumnOrder((current) => {
      const oldIndex = current.indexOf(String(active.id));
      const newIndex = current.indexOf(String(over.id));
      return oldIndex < 0 || newIndex < 0
        ? current
        : arrayMove(current, oldIndex, newIndex);
    });
  };
  const keyOpen = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(row);
    }
  };

  if (preference.isPending) return <Skeleton className="h-72" />;
  if (!rows.length)
    return (
      <EmptyState
        title={emptyTitle ?? t("common.noRecords")}
        description={emptyDescription ?? t("common.noRecordsDescription")}
      />
    );

  const visibleColumns = table.getVisibleLeafColumns();
  const visibleDataColumnCount = visibleColumns.length;
  const actionsWidth = 144;

  return (
    <div>
      <div className="app-table-shell overflow-x-auto rounded-2xl border bg-white shadow-sm">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <table
            className="table-fixed border-collapse text-left text-sm"
            style={{
              width: table.getTotalSize() + actionsWidth,
            }}
          >
            <colgroup>
              {visibleColumns.map((column) => (
                <col key={column.id} style={{ width: column.getSize() }} />
              ))}
              <col style={{ width: actionsWidth }} />
            </colgroup>
            <thead className="app-table-head bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id}>
                  <SortableContext
                    items={columnOrder}
                    strategy={horizontalListSortingStrategy}
                  >
                    {headerGroup.headers.map((header) => {
                      const sortDirection = header.column.getIsSorted();
                      return (
                        <DraggableHeader
                          key={header.id}
                          id={header.column.id}
                          label={String(header.column.columnDef.header ?? "")}
                          size={header.getSize()}
                          canSort={header.column.getCanSort()}
                          sortDirection={sortDirection}
                          onSort={header.column.getToggleSortingHandler()}
                          onMouseDownResize={header.getResizeHandler()}
                          onTouchStartResize={header.getResizeHandler()}
                        />
                      );
                    })}
                  </SortableContext>
                  <th className="app-table-head sticky right-0 z-20 w-36 border-l bg-slate-50 px-4 py-3 text-right shadow-[-6px_0_10px_-10px_rgba(15,23,42,0.45)]">
                    <div className="flex items-center justify-end gap-1.5">
                      <span>{t("common.actions")}</span>
                      {isSaving && (
                        <LoaderCircle
                          className="h-3.5 w-3.5 animate-spin text-slate-400"
                          aria-label={t("table.saving")}
                        />
                      )}
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button
                            type="button"
                            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-200 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            aria-label={t("table.columns")}
                            title={t("table.columns")}
                          >
                            <Settings2 className="h-4 w-4" aria-hidden />
                          </button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content
                            align="end"
                            sideOffset={8}
                            className="z-50 w-64 rounded-xl border bg-white p-2 text-left text-sm font-normal normal-case tracking-normal text-slate-700 shadow-xl"
                          >
                            <div className="max-h-72 overflow-y-auto py-1">
                              {columns.map((config) => {
                                const column = table.getColumn(config.key);
                                if (!column) return null;
                                const visible = column.getIsVisible();
                                return (
                                  <label
                                    key={config.key}
                                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-slate-50"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={visible}
                                      disabled={
                                        !column.getCanHide() ||
                                        (visible && visibleDataColumnCount <= 1)
                                      }
                                      onChange={column.getToggleVisibilityHandler()}
                                    />
                                    <span className="truncate">
                                      {config.label}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                            <button
                              type="button"
                              className="mt-1 w-full rounded-lg border px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              disabled={resetPreference.isPending}
                              onClick={() => {
                                if (preference.data?.supported === false) {
                                  skipNextSave.current = true;
                                  shouldFlush.current = false;
                                  setColumnOrder(defaults.columnOrder);
                                  setColumnVisibility(
                                    defaults.columnVisibility,
                                  );
                                  setColumnSizing(defaults.columnSizing);
                                  setLocalSorting(defaults.sorting);
                                  onSortingChange?.(defaults.sorting);
                                  return;
                                }
                                resetPreference.mutate();
                              }}
                            >
                              {t("table.reset")}
                            </button>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                  </th>
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onKeyDown={(event) => keyOpen(event, row.original)}
                  onClick={() => onOpen(row.original)}
                  className="app-table-row group h-14 cursor-pointer border-t transition"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="max-w-0 truncate border-r border-slate-100 px-4 py-3 align-middle last:border-r-0"
                      style={{ width: cell.column.getSize() }}
                    >
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                  <td
                    className="app-table-action-cell sticky right-0 z-10 w-36 border-l px-4 py-2 text-right shadow-[-6px_0_10px_-10px_rgba(15,23,42,0.45)] transition"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {actions?.(row.original)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </DndContext>
      </div>
    </div>
  );
}
