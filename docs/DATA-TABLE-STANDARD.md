# Data-table standard

This is the mandatory repository standard for application tables that list records. It applies to every new table and to a legacy table whenever feature work changes that table, unless the owner explicitly says not to migrate it.

## Canonical implementation

- Component: `frontend/src/components/ui/configurable-data-table.tsx`
- Column type: `ConfigurableColumn<T>`
- Preference API: `GET`, `PUT`, and `DELETE /api/v1/me/table-preferences/:tableId`
- Persistence table: `user_table_preferences`, keyed by authenticated `user_id` plus `table_id`
- Core reference: the main table in `frontend/src/features/users/UsersPage.tsx`
- Plugin reference: `plugins/crm/frontend/LeadListPage.tsx`

Do not copy the component into a feature and do not build a parallel table abstraction. Extend the canonical component when a behavior should become standard everywhere.

`frontend/src/components/ui/data-table.tsx` is legacy-only. New code must not import it. The automated guard in `tests/table-standard.test.ts` rejects additional legacy usages and new one-off raw `<table>` implementations. Extend the canonical component instead of increasing the test allowances.

## Required behavior

| Capability    | Required implementation                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Column order  | Drag by the grip in the header. Save the resulting stable column-key order per user.                                                                                                                                       |
| Visibility    | The icon-only settings trigger is inside the fixed `Ações` header. Its menu shows every hideable data column and prevents hiding the final visible data column.                                                            |
| Sorting       | Every data column supplies `sortValue`. Header clicks cycle the single-column sort state, which is saved per user.                                                                                                         |
| Resizing      | Use `columnResizeMode: "onChange"`. The width follows the held pointer continuously and stops exactly at release. Use exact widths/`colgroup`; do not stretch the table in a way that changes a neighboring column.        |
| Persistence   | Debounce writes to the authenticated preference API and flush pending state on page exit. Never make another user's preferences visible and never use shared/global state or `localStorage` as the source of truth.        |
| Reset         | Delete the authenticated user's saved preference for that `tableId` and restore declared defaults.                                                                                                                         |
| Actions       | Keep `Ações` fixed outside data-column ordering, hiding, sorting, and resizing. The column-settings control contains only the icon, plus accessible `aria-label` and `title`. Do not create a separate toolbar row for it. |
| Accessibility | Preserve semantic table markup, keyboard row opening with Enter/Space, focus styling, accessible sorting state, drag labels, and resize separators.                                                                        |
| States        | Preserve the standard loading skeleton and translated empty state.                                                                                                                                                         |

The component always renders the fixed `Ações` column so the settings icon remains available even for a read-only list with no per-row action buttons.

## Stable identifiers and persistence

Each table needs an immutable ID:

- Core: `core.<resource>`, for example `core.orders`
- Plugin: `plugin.<plugin-id>.<resource>`, for example `plugin.crm.leads`

IDs use lowercase letters, numbers, dots, underscores, or hyphens and must match the API contract. Never derive a `tableId` from a translated label, route title, or user input. Renaming a released ID disconnects existing saved preferences.

Each column `key` is also a persisted identifier. Keep it stable across label changes. When columns are added or removed, the component normalizes old preferences: new columns receive their defaults and stale keys are ignored.

No table-specific preference endpoint or migration is needed. Use the shared authenticated API and existing `user_table_preferences` storage.

## Plugin tables

Plugins use exactly the same visual component and behavior as Core tables. There is no reduced or plugin-specific table variant.

- Plugin frontend pages live under `plugins/<plugin-id>/frontend/` and are compiled into the Core SPA.
- Import `ConfigurableDataTable` from the shared Core frontend component. Do not duplicate it under the plugin directory.
- Use `tableId="plugin.<manifest-id>.<resource>"`. The manifest ID segment must match the plugin's `manifest.json` ID.
- Continue using the shared Core preference API. Do not add a preference table to plugin migrations and do not expose a plugin preference route.
- The authenticated Core user ID remains the owner of the preference, so two users automatically receive independent plugin-table layouts.
- Keep the same fixed `Ações` column and icon-only settings trigger. Plugin branding must not move, restyle, or replace this control.
- Register plugin pages in `plugins/<plugin-id>/frontend/registry.ts`, compose
  that registry in `frontend/src/plugins/registry.ts`, and follow the UI
  checklist in `plugins/template/README.md`.

The CRM Leads page is the executable plugin reference and uses `tableId="plugin.crm.leads"`.

## Column definition rules

Every data column must declare:

- `key`: immutable technical identifier;
- `label`: translated display label;
- `render`: cell presentation;
- `sortValue`: raw string or number used for ordering;
- `size`: intentional default width in pixels;
- `minSize`: smallest usable width;
- `maxSize`: largest useful width.

Use `hideable: false` only for a genuine business requirement. Sorting and the three width values are enforced by the TypeScript component contract and must not be made optional.

Starting-width guidance:

| Content                             |  `size` | `minSize` | `maxSize` |
| ----------------------------------- | ------: | --------: | --------: |
| Short status or code                | 120–160 |        96 |       240 |
| Date, number, or compact identifier | 160–200 |       120 |       320 |
| Person/resource name                | 220–260 |       140 |       600 |
| Email or longer text                | 280–360 |       180 |       800 |

These are starting ranges, not permission to omit the three values. Choose widths according to the actual content.

## Standard example

```tsx
<ConfigurableDataTable
  tableId="core.orders"
  rows={orders}
  columns={[
    {
      key: "number",
      label: t("orders.number"),
      render: (order) => order.number,
      sortValue: (order) => order.number,
      size: 180,
      minSize: 120,
      maxSize: 320,
    },
    {
      key: "customer",
      label: t("orders.customer"),
      render: (order) => order.customerName,
      sortValue: (order) => order.customerName,
      size: 260,
      minSize: 140,
      maxSize: 600,
    },
  ]}
  onOpen={(order) => openOrder(order.id)}
  actions={(order) => <OrderActions order={order} />}
/>
```

The settings icon and its menu are supplied by `ConfigurableDataTable`; feature pages must not implement another button.

## Definition of done

For every new or migrated table:

1. Use `ConfigurableDataTable` with a unique stable `tableId`.
2. Define stable column keys, translations, rendering, sorting, and all three widths.
3. Keep row actions inside the component's `actions` callback.
4. Verify reorder, show/hide, sort, live resize, exact release position, reset, and reload persistence.
5. Verify two users can keep different configurations.
6. Test that resizing one column does not change its neighbor.
7. Test that the icon-only settings trigger is inside the `Ações` header and no separate settings row exists.
8. Run `pnpm typecheck`, `pnpm test`, and the relevant build.

## Request wording

Because `AGENTS.md` makes this standard mandatory, a request can be as simple
as:

> Crie uma tabela de pedidos.

or:

> Ajuste a tabela existente de leads.

For a fully explicit request in a context that has not loaded the repository
rules, use:

> Crie/ajuste a tabela de `<recurso>` seguindo `docs/DATA-TABLE-STANDARD.md`, com preferências separadas por usuário.
