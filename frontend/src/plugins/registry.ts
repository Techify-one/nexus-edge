import type { ComponentType, LazyExoticComponent } from "react";
import {
  crmPluginRoutePaths,
  crmPluginUiRegistry,
} from "../../../plugins/crm/frontend/registry.js";
import {
  metaAdsPluginRoutePaths,
  metaAdsPluginUiRegistry,
} from "../../../plugins/meta_ads/frontend/registry.js";

type PluginPage = LazyExoticComponent<ComponentType>;
export type PluginRouteKey =
  keyof typeof crmPluginRoutePaths | keyof typeof metaAdsPluginRoutePaths;

/**
 * Plugin UI is compiled into the Core SPA. Record-list pages registered here
 * must use ConfigurableDataTable and plugin.<plugin-id>.<resource> table IDs.
 * See plugins/template/README.md and docs/DATA-TABLE-STANDARD.md.
 */
export const pluginUiRegistry: Record<PluginRouteKey, PluginPage> = {
  ...crmPluginUiRegistry,
  ...metaAdsPluginUiRegistry,
};

/**
 * Overview destinations for installed plugins. Keep this map aligned with the
 * routes in main.tsx. The first manifest menu entry with a registered path is
 * used as the plugin's primary Overview destination.
 */
export const pluginRoutePaths = {
  ...crmPluginRoutePaths,
  ...metaAdsPluginRoutePaths,
} satisfies Record<PluginRouteKey, string>;

export const resolvePluginRoute = (routeKey: string): string | undefined =>
  pluginRoutePaths[routeKey as PluginRouteKey];
