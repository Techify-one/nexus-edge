# Meta Ads plugin

Everything specific to Meta Ads is colocated here:

- [`frontend/`](./frontend/) contains the Core-compiled Meta Ads pages, route
  registry, and translations;
- [`catalog.json`](./catalog.json) contains its public catalog description;
- [`src/`](./src/) contains the private Worker API and Meta client;
- [`migrations/`](./migrations/) contains paired D1 and PostgreSQL migrations;
- [`manifest.json`](./manifest.json) defines permissions, menus, and compatibility;
- [`release/meta_ads.plugin.zip`](./release/meta_ads.plugin.zip) is the tracked installable package.

From the repository root, rebuild the package with:

```bash
pnpm --filter @app/plugin-meta-ads build
node --import tsx scripts/package-plugin.ts meta_ads
```

The Worker remains private. The plugin owns its page registry in
`frontend/registry.ts`, which the shared Core registry composes.
