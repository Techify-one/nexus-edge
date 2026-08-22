import { Card, PageHeader } from "../components/ui/index.js";
import { can } from "../lib/ability.js";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/core-client.js";
import { useI18n, type TranslationKey } from "../i18n/index.js";

const shortcuts = [
  {
    title: "nav.users",
    description: "dashboard.usersDescription",
    to: "/app/users",
    permission: "core.user.read",
  },
  {
    title: "nav.leads",
    description: "dashboard.leadsDescription",
    to: "/app/crm/leads",
    permission: "crm.lead.read",
    routeKey: "crm.leads",
  },
  {
    title: "nav.webhooks",
    description: "dashboard.webhooksDescription",
    to: "/app/settings/webhooks",
    permission: "core.webhook.read",
  },
  {
    title: "nav.plugins",
    description: "dashboard.pluginsDescription",
    to: "/app/plugins",
    permission: "core.plugin.read",
  },
] satisfies Array<{
  title: TranslationKey;
  description: TranslationKey;
  to: string;
  permission: string;
  routeKey?: string;
}>;
export default function DashboardPage() {
  const { t } = useI18n();
  const pluginNavigation = useQuery({
    queryKey: ["me", "plugin-navigation"],
    queryFn: () =>
      api<{ items: Array<{ routeKey: string }> }>(
        "/api/v1/me/plugin-navigation",
      ),
  });
  const activeRouteKeys = new Set(
    pluginNavigation.data?.items.map((item) => item.routeKey) ?? [],
  );
  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.description")}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {shortcuts
          .filter(
            (item) =>
              can(item.permission) &&
              (!("routeKey" in item) || activeRouteKeys.has(item.routeKey)),
          )
          .map((item) => (
            <Link to={item.to} key={item.to}>
              <Card className="h-full transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
                <h2 className="font-semibold">{t(item.title)}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {t(item.description)}
                </p>
              </Card>
            </Link>
          ))}
      </div>
    </>
  );
}
