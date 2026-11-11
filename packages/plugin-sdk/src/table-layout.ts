// Reserved sizing metadata, never a data-column identifier.
export const TABLE_ACTIONS_KEY = "__nexus_actions";
export const TABLE_ACTIONS_DEFAULT_WIDTH = 240;
export const TABLE_ACTIONS_MIN_WIDTH = 144;
export const TABLE_ACTIONS_MAX_WIDTH = 640;

export function tableActionsWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(
        TABLE_ACTIONS_MAX_WIDTH,
        Math.max(TABLE_ACTIONS_MIN_WIDTH, Math.round(value)),
      )
    : TABLE_ACTIONS_DEFAULT_WIDTH;
}
