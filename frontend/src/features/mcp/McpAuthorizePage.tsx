import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useState } from "react";
import { Button, Card, Skeleton } from "../../components/ui/index.js";
import { useI18n } from "../../i18n/index.js";
import { api } from "../../lib/api/core-client.js";

export default function McpAuthorizePage() {
  const { t, locale } = useI18n();
  const [params] = useSearchParams();
  const [autoSyncActions, setAutoSyncActions] = useState(true);
  const consent = useQuery({
    queryKey: ["mcp-consent", params.toString()],
    queryFn: () =>
      api<{
        clientName: string;
        redirectOrigin: string;
        actions: Array<{
          name: string;
          title: string;
          titles?: Record<string, string>;
          destructive?: boolean;
        }>;
      }>(`/api/v1/mcp/oauth/consent?${params.toString()}`),
    retry: false,
  });
  const authorize = useMutation({
    mutationFn: (approve: boolean) =>
      api<{ redirect: string }>("/api/v1/mcp/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({
          request: Object.fromEntries(params),
          approve,
          autoSyncActions: approve && autoSyncActions,
        }),
      }),
    onSuccess: ({ redirect }) => window.location.assign(redirect),
  });
  if (consent.isPending) return <Skeleton className="h-60" />;
  return (
    <Card className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("mcp.authorizeTitle")}</h1>
      {consent.isError ? (
        <p role="alert">{consent.error.message}</p>
      ) : (
        <>
          <p>
            {t("mcp.authorizeDescription", { client: consent.data.clientName })}
          </p>
          <p className="break-all text-sm text-slate-500">
            {consent.data.redirectOrigin}
          </p>
          <p className="text-sm">{t("mcp.consentPermissions")}</p>
          <ul className="max-h-72 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
            {consent.data.actions.map((action) => (
              <li key={action.name}>
                {action.titles?.[locale] ?? action.title}
                {action.destructive && (
                  <span className="block text-xs text-slate-500">
                    {t("mcp.destructive")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!consent.data.actions.length && (
            <p className="text-sm text-slate-500">
              {t("mcp.noEnabledActions")}
            </p>
          )}
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-4">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 accent-indigo-600"
              checked={autoSyncActions}
              disabled={authorize.isPending || !consent.data.actions.length}
              onChange={(event) => setAutoSyncActions(event.target.checked)}
            />
            <span>
              <span className="block font-medium">
                {t("mcp.autoSyncLabel")}
              </span>
              <span className="block text-sm text-slate-500">
                {t("mcp.autoSyncConsent")}
              </span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={authorize.isPending}
              onClick={() => authorize.mutate(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              busy={authorize.isPending}
              disabled={!consent.data.actions.length}
              onClick={() => authorize.mutate(true)}
            >
              {t("mcp.authorize")}
            </Button>
          </div>
        </>
      )}
      {authorize.isError && <p role="alert">{authorize.error.message}</p>}
    </Card>
  );
}
