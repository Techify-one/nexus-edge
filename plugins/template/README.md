# Plugin development template

Use this Worker as the backend base for a new plugin. Plugin UI is not served by the plugin Worker: it is compiled into the Core SPA and registered there.

Before copying or modifying this template, follow the complete
[`docs/PLUGIN-DEVELOPMENT.md`](../../docs/PLUGIN-DEVELOPMENT.md) guide. It is the
authoritative contract for naming, manifest policy, Wrangler builds, migrations,
packaging, private Service Bindings, retries, and release verification. Do not
replace the template's Wrangler dry-run build with a raw Node/esbuild bundle.

Before creating plugin UI, read:

- `AGENTS.md`
- `docs/PLUGIN-DEVELOPMENT.md`
- `docs/DATA-TABLE-STANDARD.md`
- `docs/INTERNATIONALIZATION.md`
- `docs/UI-STYLING-STANDARD.md`

## Public catalog

When the plugin is ready for public download, rename `catalog.example.json` to
`catalog.json`, write its category and description, and commit the generated
`release/<plugin-id>.plugin.zip`. The public catalog discovers those files from
the GitHub `main` branch automatically.

## Frontend placement

For a manifest with `"id": "inventory"`:

1. Create pages under `plugins/inventory/frontend/`.
2. Register lazy page imports and route keys in the plugin's own
   `frontend/registry.ts`, then compose it into
   `frontend/src/plugins/registry.ts` when adding the plugin.
3. Add screen-specific `pt-BR` and `en` messages to the plugin's own
   `frontend/i18n.ts`; keep only Core-wide messages in the shared catalog.
4. Use the shared Core API client for `/api/v1/p/inventory/*` routes.
5. Use `ConfigurableDataTable` for every record-list table.
6. Use the shared `Card`, form controls, `MetricCard`, and `DataValue`
   components instead of fixed light/dark surface colors. This makes the Core
   contrast hierarchy and both themes apply automatically.

The authenticated Core header supplies a **Back** button automatically for
every route registered in `frontend/src/plugins/registry.ts`. Keep all plugin
routes registered there and do not create a second page-local back button.

Do not add a second table component, raw `<table>`, plugin-specific layout, or local preference store.

## Mandatory plugin-table pattern

```tsx
import { ConfigurableDataTable } from "../../../frontend/src/components/ui/configurable-data-table.js";

<ConfigurableDataTable
  tableId="plugin.inventory.products"
  rows={products}
  columns={[
    {
      key: "name",
      label: t("products.name"),
      render: (product) => product.name,
      sortValue: (product) => product.name,
      size: 260,
      minSize: 140,
      maxSize: 600,
    },
    {
      key: "sku",
      label: t("products.sku"),
      render: (product) => product.sku,
      sortValue: (product) => product.sku,
      size: 180,
      minSize: 120,
      maxSize: 320,
    },
  ]}
  onOpen={(product) => openProduct(product.id)}
  actions={(product) => <ProductActions product={product} />}
/>;
```

The component supplies the shared layout and all required behavior:

- drag-to-reorder columns;
- show/hide columns;
- sorting for every data column;
- continuous independent resizing that stops at the pointer release position;
- fixed `Ações` column with an icon-only settings trigger;
- reset, loading/empty states, and keyboard accessibility;
- debounced preferences stored by authenticated Core user.
- distinct headers, alternating rows, dividers, and hover/focus contrast in
  both themes.

For dashboard summaries and highlighted numeric cells, import `MetricCard` and
`DataValue` from `frontend/src/components/ui/index.tsx`. Choose an intentional
`accent`, `success`, `info`, or `warning` tone; do not reproduce their colors in
plugin CSS.

Always use `plugin.<manifest-id>.<resource>` as the immutable `tableId`. Column keys must also remain stable. Do not add plugin database migrations or plugin API routes for table preferences; the Core already owns `/api/v1/me/table-preferences/:tableId` and `user_table_preferences`.

## Verification

Add interaction coverage for the plugin page and run:

```bash
pnpm typecheck
pnpm test
pnpm test:matrix
pnpm openapi:check
pnpm build
pnpm verify:artifacts
pnpm verify:bundle
pnpm format:check
```

`tests/table-standard.test.ts` rejects legacy, raw, and incorrectly namespaced plugin tables. Never increase its allowances to make new plugin code pass.
