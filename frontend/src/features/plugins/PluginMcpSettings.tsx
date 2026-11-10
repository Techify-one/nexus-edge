import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  const { t } = useI18n();
  const queryKey = ["plugin-mcp", pluginId];
  const settings = useQuery({
    queryKey,
    queryFn: () =>
      api<Settings>(`/api/v1/plugins/${encodeURIComponent(pluginId)}/mcp`),
  });
  if (settings.isPending) return <Skeleton className="h-36" />;
  if (settings.isError && !settings.data)
    return (
      <Card className="space-y-3 p-4">
        <p role="alert">{settings.error.message}</p>
        <Button variant="secondary" onClick={() => void settings.refetch()}>
          {t("common.retry")}
        </Button>
      </Card>
    );
  return (
    <PluginMcpForm key={pluginId} pluginId={pluginId} data={settings.data} />
  );
}

type Selection = Pick<Settings, "enabled" | "allowedActions">;

function PluginMcpForm({
  pluginId,
  data,
}: {
  pluginId: string;
  data: Settings;
}) {
  const { t, locale } = useI18n();
  const client = useQueryClient();
  const [draft, setDraft] = useState<Selection | null>(null);
  const selection = draft ?? data;
  const dirty =
    selection.enabled !== data.enabled ||
    selection.allowedActions.length !== data.allowedActions.length ||
    selection.allowedActions.some(
      (name) => !data.allowedActions.includes(name),
    );
  const save = useMutation({
    mutationFn: (input: Pick<Settings, "enabled" | "allowedActions">) =>
      api<Settings>(`/api/v1/plugins/${encodeURIComponent(pluginId)}/mcp`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onMutate: () =>
      client.cancelQueries({ queryKey: ["plugin-mcp", pluginId] }),
    onSuccess: (data) => {
      client.setQueryData<Settings>(["plugin-mcp", pluginId], (current) => ({
        ...current,
        ...data,
      }));
      setDraft(null);
      toast.success(t("mcp.saved"));
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });
  const disabled = !can("core.plugin.update") || save.isPending;
  const update = (patch: Partial<Selection>) =>
    setDraft((current) => ({
      enabled: (current ?? data).enabled,
      allowedActions: (current ?? data).allowedActions,
      ...patch,
    }));
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">{t("mcp.pluginTitle")}</h3>
          <p className="text-sm text-slate-500">{t("mcp.pluginDescription")}</p>
        </div>
        <ToggleSwitch
          checked={selection.enabled}
          disabled={disabled || !data.actions.length}
          aria-label={t("mcp.enable")}
          onClick={() => update({ enabled: !selection.enabled })}
        />
      </div>
      {!data.actions.length ? (
        <p className="text-sm text-slate-500">{t("mcp.noActions")}</p>
      ) : (
        <fieldset disabled={disabled} className="space-y-2">
          <legend className="mb-2 font-medium">
            {t("mcp.allowedActions")}
          </legend>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={selection.allowedActions.length === data.actions.length}
              onClick={() =>
                update({ allowedActions: data.actions.map(({ name }) => name) })
              }
            >
              {t("mcp.selectAll")}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!selection.allowedActions.length}
              onClick={() => update({ allowedActions: [] })}
            >
              {t("mcp.deselectAll")}
            </Button>
          </div>
          {data.actions.map((action) => (
            <label
              key={action.name}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-indigo-600"
                checked={selection.allowedActions.includes(action.name)}
                onChange={(event) =>
                  update({
                    allowedActions: event.target.checked
                      ? [...selection.allowedActions, action.name]
                      : selection.allowedActions.filter(
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
        {save.isPending
          ? t("mcp.saving")
          : dirty
            ? t("mcp.unsaved")
            : t("mcp.persisted")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={disabled || !dirty}
          busy={save.isPending}
          onClick={() =>
            save.mutate({
              enabled: selection.enabled,
              allowedActions: selection.allowedActions,
            })
          }
        >
          {save.isPending ? t("mcp.saving") : t("common.save")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || !dirty}
          onClick={() => setDraft(null)}
        >
          {t("mcp.discard")}
        </Button>
      </div>
      <Link
        to="/app/settings/mcp"
        className="text-sm font-medium text-indigo-600 underline"
      >
        {t("mcp.connections")}
      </Link>
    </Card>
  );
}
