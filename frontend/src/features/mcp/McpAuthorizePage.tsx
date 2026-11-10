import { useQuery, useMutation } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Button, Card, Skeleton } from "../../components/ui/index.js";
import { useI18n } from "../../i18n/index.js";
import { api } from "../../lib/api/core-client.js";

export default function McpAuthorizePage() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const consent = useQuery({
    queryKey: ["mcp-consent", params.toString()],
    queryFn: () =>
      api<{
        clientName: string;
        redirectOrigin: string;
        actions: Array<{ name: string; title: string }>;
      }>(`/api/v1/mcp/oauth/consent?${params.toString()}`),
    retry: false,
  });
  const authorize = useMutation({
    mutationFn: (approve: boolean) =>
      api<{ redirect: string }>("/api/v1/mcp/oauth/authorize", {
        method: "POST",
        body: JSON.stringify({ request: Object.fromEntries(params), approve }),
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
              <li key={action.name}>{action.title}</li>
            ))}
          </ul>
          {!consent.data.actions.length && (
            <p className="text-sm text-slate-500">
              {t("mcp.noEnabledActions")}
            </p>
          )}
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
