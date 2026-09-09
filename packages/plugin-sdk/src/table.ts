import {
  assertPluginTableId,
  type PluginHostV1,
  type PluginTablePreferenceV1,
} from "./index.js";

export type PluginTableColumnV1<Row> = {
  key: string;
  label: string;
  render: (row: Row) => Node | string | number | null | undefined;
  sortValue: (row: Row) => string | number | null | undefined;
  size: number;
  minSize: number;
  maxSize: number;
  hideable?: boolean;
};

export type PluginTableLabelsV1 = {
  actions: string;
  columns: string;
  reset: string;
  empty: string;
  loading: string;
  sortAscending: (column: string) => string;
  sortDescending: (column: string) => string;
  dragColumn: (column: string) => string;
};

const defaultLabels = (locale: PluginHostV1["locale"]): PluginTableLabelsV1 =>
  locale === "en"
    ? {
        actions: "Actions",
        columns: "Columns",
        reset: "Reset columns",
        empty: "No records found.",
        loading: "Loading table…",
        sortAscending: (column) => `Sort ${column} ascending`,
        sortDescending: (column) => `Sort ${column} descending`,
        dragColumn: (column) => `Drag to reorder ${column}`,
      }
    : {
        actions: "Ações",
        columns: "Colunas",
        reset: "Redefinir colunas",
        empty: "Nenhum registro encontrado.",
        loading: "Carregando tabela…",
        sortAscending: (column) => `Ordenar ${column} em ordem crescente`,
        sortDescending: (column) => `Ordenar ${column} em ordem decrescente`,
        dragColumn: (column) => `Arraste para reordenar ${column}`,
      };

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

const defaultsFor = <Row>(
  columns: PluginTableColumnV1<Row>[],
): PluginTablePreferenceV1 => ({
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

const normalize = <Row>(
  stored: PluginTablePreferenceV1 | null,
  columns: PluginTableColumnV1<Row>[],
): PluginTablePreferenceV1 => {
  const defaults = defaultsFor(columns);
  if (!stored || stored.version !== 1) return defaults;
  const keys = new Set(columns.map((column) => column.key));
  const storedOrder = stored.columnOrder.filter(
    (key, index, values) => keys.has(key) && values.indexOf(key) === index,
  );
  const columnOrder = [
    ...storedOrder,
    ...defaults.columnOrder.filter((key) => !storedOrder.includes(key)),
  ];
  const columnVisibility = Object.fromEntries(
    columns.map((column) => [
      column.key,
      column.hideable === false
        ? true
        : stored.columnVisibility[column.key] !== false,
    ]),
  );
  if (!Object.values(columnVisibility).some(Boolean) && columnOrder[0])
    columnVisibility[columnOrder[0]] = true;
  const byKey = new Map(columns.map((column) => [column.key, column]));
  const columnSizing = Object.fromEntries(
    columns.map((column) => [
      column.key,
      clamp(
        stored.columnSizing[column.key] ?? column.size,
        column.minSize,
        column.maxSize,
      ),
    ]),
  );
  const sorting = stored.sorting.filter(({ id }) => byKey.has(id)).slice(0, 1);
  return { version: 1, columnOrder, columnVisibility, columnSizing, sorting };
};

const cellContent = (value: Node | string | number | null | undefined): Node =>
  value instanceof Node
    ? value
    : document.createTextNode(
        value === null || value === undefined ? "" : String(value),
      );

/**
 * Framework-neutral implementation of the Nexus configurable data-table
 * contract. The action column remains fixed outside preference state.
 */
export async function mountConfigurableDataTable<
  Row extends { id: string },
>(input: {
  container: HTMLElement;
  host: PluginHostV1;
  tableId: string;
  rows: Row[];
  columns: PluginTableColumnV1<Row>[];
  onOpen: (row: Row) => void;
  actions?: (row: Row) => Node | string | null | undefined;
  labels?: Partial<PluginTableLabelsV1>;
}): Promise<{ dispose(): void }> {
  const { container, host, rows, columns, onOpen, actions } = input;
  const tableId = assertPluginTableId(host.pluginId, input.tableId);
  if (
    columns.length === 0 ||
    new Set(columns.map((column) => column.key)).size !== columns.length ||
    columns.some(
      (column) =>
        !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/u.test(column.key) ||
        column.minSize <= 0 ||
        column.maxSize < column.minSize,
    )
  )
    throw new Error("PLUGIN_TABLE_COLUMNS_INVALID");
  const labels = { ...defaultLabels(host.locale), ...input.labels };
  let disposed = false;
  let saveTimer: number | undefined;
  const loading = document.createElement("p");
  loading.className = "nexus-table-loading";
  loading.setAttribute("role", "status");
  loading.textContent = labels.loading;
  container.replaceChildren(loading);
  let state = normalize(
    await host.tablePreferences.get(tableId).catch(() => null),
    columns,
  );
  const byKey = new Map(columns.map((column) => [column.key, column]));

  const save = (): void => {
    if (saveTimer !== undefined) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      if (!disposed)
        void host.tablePreferences.set(tableId, state).catch(() =>
          host.notify({
            tone: "error",
            message:
              host.locale === "en"
                ? "Could not save the table preferences."
                : "Não foi possível salvar as preferências da tabela.",
          }),
        );
    }, 300);
  };

  const render = (): void => {
    if (disposed) return;
    container.replaceChildren();
    const visible = state.columnOrder
      .filter((key) => state.columnVisibility[key] !== false)
      .flatMap((key) => (byKey.get(key) ? [byKey.get(key)!] : []));
    const sorting = state.sorting[0];
    const displayedRows = sorting
      ? [...rows].sort((left, right) => {
          const column = byKey.get(sorting.id);
          if (!column) return 0;
          const a = column.sortValue(left);
          const b = column.sortValue(right);
          const compared =
            typeof a === "number" && typeof b === "number"
              ? a - b
              : String(a ?? "").localeCompare(String(b ?? ""), host.locale, {
                  numeric: true,
                  sensitivity: "base",
                });
          return sorting.desc ? -compared : compared;
        })
      : rows;
    const shell = document.createElement("div");
    shell.className = "nexus-table-shell";
    const table = document.createElement("table");
    table.className = "nexus-configurable-table";
    table.style.width = `${visible.reduce(
      (total, column) =>
        total + (state.columnSizing[column.key] ?? column.size),
      144,
    )}px`;
    const colgroup = document.createElement("colgroup");
    const columnElements = new Map<string, HTMLTableColElement>();
    for (const column of visible) {
      const element = document.createElement("col");
      element.style.width = `${state.columnSizing[column.key] ?? column.size}px`;
      columnElements.set(column.key, element);
      colgroup.appendChild(element);
    }
    const actionCol = document.createElement("col");
    actionCol.style.width = "144px";
    colgroup.appendChild(actionCol);
    table.appendChild(colgroup);
    const head = document.createElement("thead");
    const headerRow = document.createElement("tr");
    let draggedKey: string | null = null;
    for (const column of visible) {
      const th = document.createElement("th");
      th.scope = "col";
      th.draggable = true;
      th.dataset.columnKey = column.key;
      th.setAttribute(
        "aria-sort",
        sorting?.id === column.key
          ? sorting.desc
            ? "descending"
            : "ascending"
          : "none",
      );
      const sort = document.createElement("button");
      sort.type = "button";
      sort.className = "nexus-table-sort";
      sort.textContent = `${column.label}${sorting?.id === column.key ? (sorting.desc ? " ↓" : " ↑") : " ↕"}`;
      sort.title =
        sorting?.id === column.key && !sorting.desc
          ? labels.sortDescending(column.label)
          : labels.sortAscending(column.label);
      sort.addEventListener("click", () => {
        state = {
          ...state,
          sorting:
            sorting?.id !== column.key
              ? [{ id: column.key, desc: false }]
              : sorting.desc
                ? []
                : [{ id: column.key, desc: true }],
        };
        save();
        render();
      });
      th.appendChild(sort);
      th.title = labels.dragColumn(column.label);
      th.addEventListener("dragstart", () => {
        draggedKey = column.key;
      });
      th.addEventListener("dragover", (event) => event.preventDefault());
      th.addEventListener("drop", (event) => {
        event.preventDefault();
        if (!draggedKey || draggedKey === column.key) return;
        const next = [...state.columnOrder];
        const from = next.indexOf(draggedKey);
        const to = next.indexOf(column.key);
        if (from < 0 || to < 0) return;
        next.splice(to, 0, next.splice(from, 1)[0]!);
        state = { ...state, columnOrder: next };
        draggedKey = null;
        save();
        render();
      });
      const resize = document.createElement("span");
      resize.className = "nexus-table-resize";
      resize.setAttribute("role", "separator");
      resize.setAttribute("aria-orientation", "vertical");
      resize.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        resize.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = state.columnSizing[column.key] ?? column.size;
        const move = (moveEvent: PointerEvent) => {
          const width = clamp(
            startWidth + moveEvent.clientX - startX,
            column.minSize,
            column.maxSize,
          );
          state = {
            ...state,
            columnSizing: { ...state.columnSizing, [column.key]: width },
          };
          const element = columnElements.get(column.key);
          if (element) element.style.width = `${width}px`;
          table.style.width = `${visible.reduce(
            (total, item) =>
              total + (state.columnSizing[item.key] ?? item.size),
            144,
          )}px`;
        };
        const finish = () => {
          resize.removeEventListener("pointermove", move);
          resize.removeEventListener("pointerup", finish);
          resize.removeEventListener("pointercancel", finish);
          save();
        };
        resize.addEventListener("pointermove", move);
        resize.addEventListener("pointerup", finish);
        resize.addEventListener("pointercancel", finish);
      });
      th.appendChild(resize);
      headerRow.appendChild(th);
    }
    const actionHeader = document.createElement("th");
    actionHeader.scope = "col";
    actionHeader.className = "nexus-table-actions";
    const actionLabel = document.createElement("span");
    actionLabel.textContent = labels.actions;
    actionHeader.appendChild(actionLabel);
    const settings = document.createElement("details");
    settings.className = "nexus-table-settings";
    const settingsTrigger = document.createElement("summary");
    settingsTrigger.textContent = "⚙";
    settingsTrigger.title = labels.columns;
    settingsTrigger.setAttribute("aria-label", labels.columns);
    settings.appendChild(settingsTrigger);
    const settingsPanel = document.createElement("div");
    settingsPanel.className = "nexus-table-settings-panel";
    for (const column of columns) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.columnVisibility[column.key] !== false;
      checkbox.disabled =
        column.hideable === false || (checkbox.checked && visible.length <= 1);
      checkbox.addEventListener("change", () => {
        state = {
          ...state,
          columnVisibility: {
            ...state.columnVisibility,
            [column.key]: checkbox.checked,
          },
        };
        save();
        render();
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(column.label));
      settingsPanel.appendChild(label);
    }
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = labels.reset;
    reset.addEventListener("click", () => {
      state = defaultsFor(columns);
      save();
      render();
    });
    settingsPanel.appendChild(reset);
    settings.appendChild(settingsPanel);
    actionHeader.appendChild(settings);
    headerRow.appendChild(actionHeader);
    head.appendChild(headerRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    if (!displayedRows.length) {
      const emptyRow = document.createElement("tr");
      const emptyCell = document.createElement("td");
      emptyCell.className = "nexus-table-empty";
      emptyCell.colSpan = visible.length + 1;
      emptyCell.textContent = labels.empty;
      emptyRow.appendChild(emptyCell);
      body.appendChild(emptyRow);
    }
    for (const row of displayedRows) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.dataset.rowId = row.id;
      tr.addEventListener("click", () => onOpen(row));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(row);
        }
      });
      for (const column of visible) {
        const td = document.createElement("td");
        td.appendChild(cellContent(column.render(row)));
        tr.appendChild(td);
      }
      const actionCell = document.createElement("td");
      actionCell.className = "nexus-table-actions";
      actionCell.addEventListener("click", (event) => event.stopPropagation());
      const renderedActions = actions?.(row);
      if (renderedActions !== undefined && renderedActions !== null)
        actionCell.appendChild(cellContent(renderedActions));
      tr.appendChild(actionCell);
      body.appendChild(tr);
    }
    table.appendChild(body);
    shell.appendChild(table);
    container.appendChild(shell);
  };
  render();
  return {
    dispose() {
      disposed = true;
      if (saveTimer !== undefined) {
        window.clearTimeout(saveTimer);
        void host.tablePreferences.set(tableId, state).catch(() => undefined);
      }
      container.replaceChildren();
    },
  };
}
