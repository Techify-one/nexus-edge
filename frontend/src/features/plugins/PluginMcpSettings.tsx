import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import {
  Card,
  Button,
  Skeleton,
  ToggleSwitch,
} from "../../components/ui/index.js";
import { useI18n } from "../../i18n/index.js";
import { api } from "../../lib/api/core-client.js";
import { can } from "../../lib/ability.js";

type Settings = {
  enabled: boolean;
  allowedActions: string[];
  endpoint: string;
  actions: Array<{
    name: string;
    title: string;
    titles?: Record<string, string>;
    destructive: boolean;
  }>;
};

export function PluginMcpSettings({ pluginId }: { pluginId: string }) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const queryKey = ["plugin-mcp", pluginId];
  const settings = useQuery({
    queryKey,
    queryFn: () =>
      api<Settings>(`/api/v1/plugins/${encodeURIComponent(pluginId)}/mcp`),
  });
  const save = useMutation({
    mutationFn: (input: Pick<Settings, "enabled" | "allowedActions">) =>
      api<Settings>(`/api/v1/plugins/${encodeURIComponent(pluginId)}/mcp`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onMutate: (input) => {
      void client.cancelQueries({ queryKey });
      const previous = client.getQueryData<Settings>(queryKey);
      if (previous) client.setQueryData(queryKey, { ...previous, ...input });
      return { previous };
    },
    onSuccess: (data) => {
      client.setQueryData<Settings>(queryKey, (current) => ({
        ...current,
        ...data,
      }));
      toast.success(t("mcp.saved"));
    },
    onError: (error, _input, context) => {
      if (context?.previous) client.setQueryData(queryKey, context.previous);
      toast.error(error.message);
    },
  });
  if (settings.isPending) return <Skeleton className="h-36" />;
  if (settings.isError)
    return (
      <Card className="space-y-3 p-4">
        <p role="alert">{settings.error.message}</p>
        <Button variant="secondary" onClick={() => void settings.refetch()}>
          {t("common.retry")}
        </Button>
      </Card>
    );
  const data = settings.data;
  const disabled = !can("core.plugin.update") || save.isPending;
  const update = (
    patch: Partial<Pick<Settings, "enabled" | "allowedActions">>,
  ) =>
    save.mutate({
      enabled: data.enabled,
      allowedActions: data.allowedActions,
      ...patch,
    });
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{t("mcp.pluginTitle")}</h3>
          <p className="text-sm text-slate-500">{t("mcp.pluginDescription")}</p>
        </div>
        <ToggleSwitch
          checked={data.enabled}
          disabled={disabled || !data.actions.length}
          aria-label={t("mcp.enable")}
          onClick={() => update({ enabled: !data.enabled })}
        />
      </div>
      {!data.actions.length ? (
        <p className="text-sm text-slate-500">{t("mcp.noActions")}</p>
      ) : (
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 font-medium">
            {t("mcp.allowedActions")}
          </legend>
          {data.actions.map((action) => (
            <label
              key={action.name}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-indigo-600"
                checked={data.allowedActions.includes(action.name)}
                onChange={(event) =>
                  update({
                    allowedActions: event.target.checked
                      ? [...data.allowedActions, action.name]
                      : data.allowedActions.filter(
                          (name) => name !== action.name,
                        ),
                  })
                }
              />
              <span>
                <span className="block">
                  {action.titles?.[locale] ?? action.title}
                </span>
                {action.destructive && (
                  <span className="text-xs text-slate-500">
                    {t("mcp.destructive")}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <p role="status" className="text-xs text-slate-500">
        {save.isPending ? t("mcp.saving") : t("mcp.persisted")}
      </p>
      <Link
        to="/app/settings/mcp"
        className="text-sm font-medium text-indigo-600 underline"
      >
        {t("mcp.connections")}
      </Link>
    </Card>
  );
}
