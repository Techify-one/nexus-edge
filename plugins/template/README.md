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
