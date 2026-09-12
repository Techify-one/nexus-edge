import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell.js";
import { Button, Skeleton } from "../components/ui/index.js";
import { useI18n } from "../i18n/index.js";
import { updateAbility } from "../lib/ability.js";
import { ApiError, api } from "../lib/api/core-client.js";
import { PersistentPluginSurfaceHost } from "../plugins/PersistentPluginSurfaceHost.js";

export function AuthenticatedLayout() {
  const { t } = useI18n();
  const session = useQuery({
    queryKey: ["me"],
    queryFn: () => api("/api/v1/me"),
  });
  const rules = useQuery({
    queryKey: ["me", "ability"],
    queryFn: () => api<{ rules: unknown }>("/api/v1/me/ability"),
    enabled: session.isSuccess,
  });
  if (session.isError) {
    if (session.error instanceof ApiError && session.error.status === 401)
      return <Navigate to="/login" replace />;
    return (
      <main className="mx-auto max-w-xl p-8 text-center">
        <h1 className="text-xl font-bold">{t("errors.sessionUnavailable")}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {session.error instanceof ApiError && session.error.status === 429
            ? t("errors.RATE_LIMITED")
            : t("errors.fallback")}
        </p>
        <Button className="mt-5" onClick={() => void session.refetch()}>
          {t("common.retry")}
        </Button>
      </main>
    );
  }
  if (session.isPending || rules.isPending)
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-8">
        <Skeleton className="h-16" />
        <Skeleton className="h-80" />
      </main>
    );
  if (rules.data) updateAbility(rules.data.rules);
  return (
    <PersistentPluginSurfaceHost>
      <AppShell />
    </PersistentPluginSurfaceHost>
  );
}
