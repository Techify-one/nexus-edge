import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router-dom";
import { AppShell } from "../components/layout/AppShell.js";
import { Skeleton } from "../components/ui/index.js";
import { updateAbility } from "../lib/ability.js";
import { api } from "../lib/api/core-client.js";

export function AuthenticatedLayout() {
  const session = useQuery({
    queryKey: ["me"],
    queryFn: () => api("/api/v1/me"),
  });
  const rules = useQuery({
    queryKey: ["me", "ability"],
    queryFn: () => api<{ rules: unknown }>("/api/v1/me/ability"),
    enabled: session.isSuccess,
  });
  if (session.isError) return <Navigate to="/login" replace />;
  if (session.isPending || rules.isPending)
    return (
      <main className="mx-auto max-w-6xl space-y-4 p-8">
        <Skeleton className="h-16" />
        <Skeleton className="h-80" />
      </main>
    );
  if (rules.data) updateAbility(rules.data.rules);
  return <AppShell />;
}
