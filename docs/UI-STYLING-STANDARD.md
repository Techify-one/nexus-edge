# Interface surface and contrast standard

This standard applies to every Core screen and compiled plugin screen. The
application owns one light/dark theme and a shared visual hierarchy; plugins
must inherit it instead of defining an independent palette.

## Required building blocks

- Use `Card` for grouped content and `SingleLineFilterBar` for related filters.
- Use the shared `Input`, `Select`, and `Textarea` controls for form surfaces.
- Use `MetricCard` for summary numbers and `DataValue` for numeric values that
  need emphasis inside tables or detail panels.
- Use `ConfigurableDataTable` for every record-list table. Its header,
  alternating rows, dividers, sticky actions, and hover/focus states are the
  canonical table contrast treatment.

These components are exported from `frontend/src/components/ui/index.tsx`,
except for `ConfigurableDataTable`, which is exported from
`frontend/src/components/ui/configurable-data-table.tsx`.

## Surface hierarchy

Every screen must preserve at least three visible levels:

1. the application background;
2. grouped cards, filters, or table containers;
3. raised controls, table headers, alternating rows, or highlighted values.

Do not hard-code white, black, or a plugin-owned page/table background. Use the
shared components and semantic classes so both themes retain blue-toned depth,
visible borders, and accessible foreground contrast.

## Semantic data tones

`MetricCard` and `DataValue` accept these tones:

- `accent`: primary counts or selected totals;
- `success`: revenue, completed outcomes, or healthy states;
- `info`: informational rates and supporting counts;
- `warning`: cost, attention, or constrained values.

Choose a tone for meaning, not decoration. Do not encode the same meaning with
different tones on the same screen, and never rely on color alone to communicate
status.

## Verification

Check every changed screen in light and dark themes. Confirm that cards remain
distinct from the page, fields remain distinct from cards, table rows alternate,
hover/focus states are visible, and highlighted values keep readable text and
borders. Add component or interaction coverage when extending the shared visual
contract.
