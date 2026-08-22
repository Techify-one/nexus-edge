# Repository instructions

Read and follow `AGENTS.md` before changing this repository. Its deployment, safety, database-provider, and data-table rules are mandatory.

For every request that creates a table or changes an existing record-list table, also read and follow `docs/DATA-TABLE-STANDARD.md`. Use the canonical `ConfigurableDataTable`; do not add a legacy `DataTable` usage, a raw one-off table, or expand the allowances in `tests/table-standard.test.ts`.
