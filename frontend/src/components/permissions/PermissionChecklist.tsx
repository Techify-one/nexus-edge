import { useMemo } from "react";
import { useI18n } from "../../i18n/index.js";
import { groupPermissions, permissionLabel } from "../../lib/permissions.js";

type Permission = { id: string; key: string };

export function PermissionChecklist({
  permissions,
  name,
  defaultSelectedKeys = [],
}: {
  permissions: Permission[];
  name: string;
  defaultSelectedKeys?: string[];
}) {
  const { locale, t } = useI18n();
  const selected = useMemo(
    () => new Set(defaultSelectedKeys),
    [defaultSelectedKeys],
  );
  const sections = useMemo(
    () => groupPermissions(permissions, t),
    [locale, permissions, t],
  );

  return (
    <div className="max-h-80 space-y-5 overflow-y-auto rounded-xl border p-3">
      {sections.map((section) => (
        <section key={section.id} aria-labelledby={`permission-${section.id}`}>
          <h3
            id={`permission-${section.id}`}
            className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500"
          >
            {section.label}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {section.permissions.map((permission) => (
              <label
                key={permission.id}
                className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50"
              >
                <input
                  className="mt-0.5"
                  type="checkbox"
                  name={name}
                  value={permission.key}
                  defaultChecked={selected.has(permission.key)}
                />
                <span>{permissionLabel(permission.key, t)}</span>
              </label>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
