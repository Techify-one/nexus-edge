import { hasTranslation, type TranslationKey } from "../i18n/index.js";

type Translator = (
  key: TranslationKey,
  values?: Record<string, string | number>,
) => string;

export const permissionLabel = (key: string, t: Translator): string => {
  const translationKey = `permissions.${key}`;
  return hasTranslation(translationKey)
    ? t(translationKey)
    : t("permissions.additional");
};

export const permissionGroupLabel = (key: string, t: Translator): string => {
  const group = key.split(".").slice(0, 2).join(".");
  const translationKey = `permissionGroups.${group}`;
  return hasTranslation(translationKey)
    ? t(translationKey)
    : t("permissionGroups.additional");
};

export const groupPermissions = <Permission extends { key: string }>(
  permissions: Permission[],
  t: Translator,
) => {
  const actionOrder = new Map(
    ["read", "create", "update", "delete", "export", "test", "redeliver"].map(
      (action, index) => [action, index],
    ),
  );
  const sectionOrder = new Map(
    [
      "core.user",
      "core.group",
      "core.plugin",
      "core.webhook",
      "core.audit",
      "core.settings",
    ].map((section, index) => [section, index]),
  );
  const sections = new Map<
    string,
    { id: string; label: string; permissions: Permission[] }
  >();
  for (const permission of permissions) {
    const id = permission.key.split(".").slice(0, 2).join(".");
    const section = sections.get(id) ?? {
      id,
      label: permissionGroupLabel(permission.key, t),
      permissions: [],
    };
    section.permissions.push(permission);
    sections.set(id, section);
  }
  return [...sections.values()]
    .sort(
      (left, right) =>
        (sectionOrder.get(left.id) ?? 1_000) -
          (sectionOrder.get(right.id) ?? 1_000) ||
        left.label.localeCompare(right.label),
    )
    .map((section) => ({
      ...section,
      permissions: section.permissions.toSorted((left, right) => {
        const leftAction = left.key.split(".").at(-1) ?? "";
        const rightAction = right.key.split(".").at(-1) ?? "";
        return (
          (actionOrder.get(leftAction) ?? 1_000) -
            (actionOrder.get(rightAction) ?? 1_000) ||
          left.key.localeCompare(right.key)
        );
      }),
    }));
};
