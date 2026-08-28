import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import {
  crmPluginRoutePaths,
  crmPluginUiRegistry,
} from "../../../plugins/crm/frontend/registry.js";
import {
  metaAdsPluginRoutePaths,
  metaAdsPluginUiRegistry,
} from "../../../plugins/meta_ads/frontend/registry.js";
import {
  soletrandoPluginRoutePaths,
  soletrandoPluginUiRegistry,
} from "../../../plugins/soletrando/frontend/registry.js";
import {
  meetingRecorderPersistentSurface,
  meetingRecorderPluginRoutePaths,
  meetingRecorderPluginUiRegistry,
} from "../../../plugins/meeting_recorder/frontend/registry.js";
export {
  SoletrandoChildDetailPage,
  SoletrandoPracticePage,
} from "../../../plugins/soletrando/frontend/registry.js";

type PluginPage = LazyExoticComponent<ComponentType>;
export type PluginRouteKey =
  | keyof typeof crmPluginRoutePaths
  | keyof typeof metaAdsPluginRoutePaths
  | keyof typeof soletrandoPluginRoutePaths
  | keyof typeof meetingRecorderPluginRoutePaths;

/**
 * Plugin UI is compiled into the Core SPA. Record-list pages registered here
 * must use ConfigurableDataTable and plugin.<plugin-id>.<resource> table IDs.
 * See plugins/template/README.md and docs/DATA-TABLE-STANDARD.md.
 */
export const pluginUiRegistry: Record<PluginRouteKey, PluginPage> = {
  ...crmPluginUiRegistry,
  ...metaAdsPluginUiRegistry,
  ...soletrandoPluginUiRegistry,
  ...meetingRecorderPluginUiRegistry,
};

/**
 * Overview destinations for installed plugins. Keep this map aligned with the
 * routes in main.tsx. The first manifest menu entry with a registered path is
 * used as the plugin's primary Overview destination.
 */
export const pluginRoutePaths = {
  ...crmPluginRoutePaths,
  ...metaAdsPluginRoutePaths,
  ...soletrandoPluginRoutePaths,
  ...meetingRecorderPluginRoutePaths,
} satisfies Record<PluginRouteKey, string>;

export const persistentPluginSurfaceRegistry = {
  meeting_recorder: meetingRecorderPersistentSurface,
} satisfies Record<string, ComponentType<{ children: ReactNode }>>;

export const resolvePluginRoute = (routeKey: string): string | undefined =>
  pluginRoutePaths[routeKey as PluginRouteKey];
