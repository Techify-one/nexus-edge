import { Package, Search } from "lucide-react";
import { useState } from "react";
import { Card, Input, PageHeader, Skeleton } from "../components/ui/index.js";
import { can } from "../lib/ability.js";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/core-client.js";
import { useI18n, type TranslationKey } from "../i18n/index.js";
import { resolvePluginRoute } from "../plugins/registry.js";

const shortcuts = [
  {
    title: "nav.users",
    description: "dashboard.usersDescription",
    to: "/app/users",
    permission: "core.user.read",
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
}>;

type PluginNavigation = {
  pluginId: string;
  name: string;
  menu: Array<{ title: string; routeKey: string }>;
};

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();

export const filterPluginOverview = (
  plugins: PluginNavigation[],
  search: string,
) => {
  const query = normalizeSearch(search.trim());
  return plugins
    .map((plugin) => {
      const primaryEntry = plugin.menu.find((entry) =>
        Boolean(resolvePluginRoute(entry.routeKey)),
      );
      return {
        ...plugin,
        primaryEntry,
        to: primaryEntry
          ? resolvePluginRoute(primaryEntry.routeKey)
          : undefined,
      };
    })
    .filter((plugin) => {
      if (!query) return true;
      return normalizeSearch(
        [
          plugin.pluginId,
          plugin.name,
          ...plugin.menu.flatMap((entry) => [entry.title, entry.routeKey]),
        ].join(" "),
      ).includes(query);
    });
};

export default function DashboardPage() {
  const { t } = useI18n();
  const [pluginSearch, setPluginSearch] = useState("");
  const pluginNavigation = useQuery({
    queryKey: ["me", "plugin-navigation"],
    queryFn: () =>
      api<{ plugins: PluginNavigation[] }>("/api/v1/me/plugin-navigation"),
  });
  const visiblePlugins = filterPluginOverview(
    pluginNavigation.data?.plugins ?? [],
    pluginSearch,
  );
  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.description")}
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {shortcuts
          .filter((item) => can(item.permission))
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
      <section className="mt-8" aria-labelledby="installed-plugins-title">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="installed-plugins-title" className="text-lg font-semibold">
              {t("dashboard.installedPlugins")}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {t("dashboard.installedPluginsDescription")}
            </p>
          </div>
          <div className="relative w-full sm:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <Input
              value={pluginSearch}
              onChange={(event) => setPluginSearch(event.target.value)}
              className="pl-9"
              placeholder={t("dashboard.searchPlugins")}
              aria-label={t("dashboard.searchPlugins")}
            />
          </div>
        </div>
        {pluginNavigation.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Skeleton className="h-28" />
            <Skeleton className="h-28" />
          </div>
        ) : visiblePlugins.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {visiblePlugins.map((plugin) => {
              const menuSummary = plugin.menu
                .map((entry) => entry.title)
                .filter((title) => title !== plugin.name)
                .join(" · ");
              const content = (
                <Card className="h-full transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
                  <div className="flex items-start gap-3">
                    <div className="rounded-xl bg-indigo-50 p-2 text-indigo-700">
                      <Package className="h-5 w-5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{plugin.name}</h3>
                      <p className="mt-1 truncate text-sm text-slate-500">
                        {menuSummary ||
                          (plugin.primaryEntry
                            ? t("dashboard.openPlugin")
                            : t("dashboard.pluginWithoutPage"))}
                      </p>
                    </div>
                  </div>
                </Card>
              );
              return plugin.to ? (
                <Link to={plugin.to} key={plugin.pluginId}>
                  {content}
                </Link>
              ) : (
                <div key={plugin.pluginId}>{content}</div>
              );
            })}
          </div>
        ) : (
          <Card className="py-8 text-center text-sm text-slate-500">
            {t(
              pluginSearch.trim()
                ? "dashboard.noPluginResults"
                : "dashboard.noInstalledPlugins",
            )}
          </Card>
        )}
      </section>
    </>
  );
}
