# Plugins

The Core repository contains only a format-2 author template. Installable
plugins live in independent GitHub marketplace repositories and are loaded at
runtime, so adding a plugin never requires a Core source change.

```text
<plugin-id>/
  frontend/                 runtime-loaded plugin pages
  migrations/d1/            D1 migrations
  migrations/postgres/      PostgreSQL migrations
  src/                      private Worker source
  manifest.json             Installer contract
  package.json              workspace package and build commands
  tsconfig.json             Worker TypeScript configuration
  wrangler.jsonc            private Worker build configuration
```

The default signed catalog is published from
[`Techify-one/nexus-edge-plugins`](https://github.com/Techify-one/nexus-edge-plugins).
Use [the template](./template/README.md) for a new plugin and publish its signed
ZIP and catalog entry from a marketplace repository.

Follow [`docs/PLUGIN-DEVELOPMENT.md`](../docs/PLUGIN-DEVELOPMENT.md) before
creating or changing a plugin.
