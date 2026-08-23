import {
  KeyRound,
  Package,
  ScrollText,
  Search,
  UserRoundCog,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Card, Input, PageHeader, Skeleton } from "../components/ui/index.js";
import { can } from "../lib/ability.js";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/core-client.js";
import { useI18n, type TranslationKey } from "../i18n/index.js";
import { resolvePluginRoute } from "../plugins/registry.js";

const coreModules = [
  {
    id: "core.users",
    title: "nav.users",
    description: "dashboard.usersDescription",
    to: "/app/users",
    icon: Users,
    permission: "core.user.read",
  },
  {
    id: "core.groups",
    title: "nav.groups",
    description: "dashboard.groupsDescription",
    to: "/app/groups",
    icon: UserRoundCog,
    permission: "core.group.read",
  },
  {
    id: "core.api-keys",
    title: "nav.apiKeys",
    description: "dashboard.apiKeysDescription",
    to: "/app/settings/api-keys",
    icon: KeyRound,
  },
  {
    id: "core.webhooks",
    title: "nav.webhooks",
    description: "dashboard.webhooksDescription",
    to: "/app/settings/webhooks",
    icon: Webhook,
    permission: "core.webhook.read",
  },
  {
    id: "core.plugins",
    title: "nav.plugins",
    description: "dashboard.pluginsDescription",
    to: "/app/plugins",
    icon: Package,
    permission: "core.plugin.read",
  },
  {
    id: "core.audit",
    title: "nav.audit",
    description: "dashboard.auditDescription",
    to: "/app/audit",
    icon: ScrollText,
    permission: "core.audit.read",
  },
] satisfies Array<{
  id: string;
  title: TranslationKey;
  description: TranslationKey;
  to: string;
  icon: LucideIcon;
  permission?: string;
}>;

type PluginNavigation = {
  pluginId: string;
  name: string;
  menu: Array<{ title: string; routeKey: string }>;
};

type OverviewCard = {
  id: string;
  title: string;
  description: string;
  to: string | undefined;
  icon: LucideIcon;
  searchTerms: string[];
};

const normalizeSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();

export const filterOverviewCards = (cards: OverviewCard[], search: string) => {
  const query = normalizeSearch(search.trim());
  if (!query) return cards;
  return cards.filter((card) =>
    normalizeSearch(
      [card.title, card.description, ...card.searchTerms].join(" "),
    ).includes(query),
  );
};

export default function DashboardPage() {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const pluginNavigation = useQuery({
    queryKey: ["me", "plugin-navigation"],
    queryFn: () =>
      api<{ plugins: PluginNavigation[] }>("/api/v1/me/plugin-navigation"),
  });
  const coreCards: OverviewCard[] = coreModules
    .filter((module) => !module.permission || can(module.permission))
    .map((module) => ({
      id: module.id,
      title: t(module.title),
      description: t(module.description),
      to: module.to,
      icon: module.icon,
      searchTerms: [module.id, module.to],
    }));
  const pluginCards: OverviewCard[] = (
    pluginNavigation.data?.plugins ?? []
  ).map((plugin) => {
    const primaryEntry = plugin.menu.find((entry) =>
      Boolean(resolvePluginRoute(entry.routeKey)),
    );
    const menuSummary = plugin.menu
      .map((entry) => entry.title)
      .filter((title) => title !== plugin.name)
      .join(" · ");
    return {
      id: `plugin.${plugin.pluginId}`,
      title: plugin.name,
      description:
        menuSummary ||
        (primaryEntry
          ? t("dashboard.openPlugin")
          : t("dashboard.pluginWithoutPage")),
      to: primaryEntry ? resolvePluginRoute(primaryEntry.routeKey) : undefined,
      icon: Package,
      searchTerms: [
        plugin.pluginId,
        ...plugin.menu.flatMap((entry) => [entry.title, entry.routeKey]),
      ],
    };
  });
  const visibleCards = filterOverviewCards(
    [...coreCards, ...pluginCards],
    search,
  );

  return (
    <>
      <PageHeader
        title={t("dashboard.title")}
        description={t("dashboard.description")}
        action={
          <div className="relative w-full sm:w-80">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="pl-9"
              placeholder={t("dashboard.searchModules")}
              aria-label={t("dashboard.searchModules")}
            />
          </div>
        }
      />
      {visibleCards.length || pluginNavigation.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {visibleCards.map((card) => {
            const Icon = card.icon;
            const content = (
              <Card className="h-full transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
                <div className="flex items-start gap-3">
                  <div className="rounded-xl bg-indigo-50 p-2 text-indigo-700">
                    <Icon className="h-5 w-5" aria-hidden />
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate font-semibold">{card.title}</h2>
                    <p className="mt-1 truncate text-sm text-slate-500">
                      {card.description}
                    </p>
                  </div>
                </div>
              </Card>
            );
            return card.to ? (
              <Link to={card.to} key={card.id}>
                {content}
              </Link>
            ) : (
              <div key={card.id}>{content}</div>
            );
          })}
          {pluginNavigation.isLoading && !search.trim() && (
            <>
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </>
          )}
        </div>
      ) : (
        <Card className="py-8 text-center text-sm text-slate-500">
          {t("dashboard.noResults")}
        </Card>
      )}
    </>
  );
}
