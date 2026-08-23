# CRM plugin

Everything specific to CRM is colocated here:

- [`frontend/`](./frontend/) contains the Core-compiled CRM pages, route
  registry, translations, and typed CRM API client;
- [`catalog.json`](./catalog.json) contains its public catalog description;
- [`src/`](./src/) contains the private Worker API and business logic;
- [`migrations/`](./migrations/) contains paired D1 and PostgreSQL migrations;
- [`manifest.json`](./manifest.json) defines permissions, menus, and compatibility;
- [`release/crm.plugin.zip`](./release/crm.plugin.zip) is the tracked installable package.

From the repository root, rebuild the package with:

```bash
pnpm --filter @app/plugin-crm build
node --import tsx scripts/package-plugin.ts crm
```

The Worker remains private. The plugin owns its page registry in
`frontend/registry.ts`, which the shared Core registry composes.
