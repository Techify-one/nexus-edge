# Nexus Edge plugin catalog Worker

This public Worker renders the downloadable plugin catalog at
`https://nexus-edge-plugins.francisconeto.workers.dev`.

The Worker does not contain copies of plugin packages. At runtime it discovers
the public GitHub `main` tree and lists every `plugins/<id>/` directory that has
all three catalog inputs:

- `catalog.json` for the public category and description;
- `manifest.json` for the plugin name and versions;
- `release/<id>.plugin.zip` for the installable package.

Downloads pass through `/download/<id>` so a successful GitHub response can be
counted atomically in the D1 `plugin_catalog_downloads` table. The GitHub tree
and small metadata files have a 60-second edge cache; the ZIP is streamed from
GitHub and is never duplicated in this directory.

After a successful refresh, the Worker persists the last validated catalog
metadata in `plugin_catalog_source_cache`. It uses that snapshot only when
GitHub is temporarily unavailable; every normal refresh still reads GitHub,
and package bytes continue to come from the immutable Git revision recorded by
the successful refresh.

Use the repository-wide verification workflow before publication. Production
is deployed only by `.github/workflows/ci.yml` after the additive D1 migrations.
