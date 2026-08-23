# Plugins

Every plugin is a complete, self-contained development unit under this
directory. Open one plugin directory to edit its Worker, Core-compiled frontend,
manifest, paired database migrations, tests referenced by the repository, and
installable release package without searching across feature folders.

```text
<plugin-id>/
  frontend/                 Core-compiled React pages
  migrations/d1/            D1 migrations
  migrations/postgres/      PostgreSQL migrations
  release/                  tracked installable .plugin.zip
  src/                      private Worker source
  manifest.json             Installer contract
  package.json              workspace package and build commands
  tsconfig.json             Worker TypeScript configuration
  wrangler.jsonc            private Worker build configuration
```

## Catalog

- [CRM](./crm/README.md)
- [Meta Ads](./meta_ads/README.md)
- [Plugin template](./template/README.md)

Each plugin owns its page registry under `frontend/registry.ts`. The shared
`frontend/src/plugins/registry.ts` only composes those registries because final
route availability belongs to the Core SPA. Shared UI components, the i18n
runtime, the base API client, and Installer code remain Core-owned and must not
be copied into individual plugins; plugin-specific messages and clients stay
with their plugin.

Follow [`docs/PLUGIN-DEVELOPMENT.md`](../docs/PLUGIN-DEVELOPMENT.md) before
creating or changing a plugin.
