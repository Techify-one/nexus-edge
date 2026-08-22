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
} satisfies Record<string, PluginPage>;

export type PluginRouteKey = keyof typeof pluginUiRegistry;
