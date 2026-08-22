import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type PluginPage = LazyExoticComponent<ComponentType>;

/**
 * Plugin UI is compiled into the Core SPA. Record-list pages registered here
 * must use ConfigurableDataTable and plugin.<plugin-id>.<resource> table IDs.
 * See workers/plugin-template/README.md and docs/DATA-TABLE-STANDARD.md.
 */
export const pluginUiRegistry = {
  "crm.home": lazy(() => import("./crm/CrmHomePage.js")),
  "crm.leads": lazy(() => import("./crm/LeadListPage.js")),
  "meta_ads.home": lazy(() => import("./meta_ads/MetaAdsHomePage.js")),
  "meta_ads.dashboard": lazy(
    () => import("./meta_ads/MetaAdsDashboardPage.js"),
  ),
  "meta_ads.accounts": lazy(() => import("./meta_ads/MetaAdsAccountsPage.js")),
} satisfies Record<string, PluginPage>;

export type PluginRouteKey = keyof typeof pluginUiRegistry;

/**
 * Overview destinations for installed plugins. Keep this map aligned with the
 * routes in main.tsx. The first manifest menu entry with a registered path is
 * used as the plugin's primary Overview destination.
 */
export const pluginRoutePaths = {
  "crm.home": "/app/crm",
  "crm.leads": "/app/crm/leads",
  "meta_ads.home": "/app/meta-ads",
  "meta_ads.dashboard": "/app/meta-ads",
  "meta_ads.accounts": "/app/meta-ads/accounts",
} satisfies Record<PluginRouteKey, string>;

export const resolvePluginRoute = (routeKey: string): string | undefined =>
  pluginRoutePaths[routeKey as PluginRouteKey];
