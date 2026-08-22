import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type PluginPage = LazyExoticComponent<ComponentType>;

export const pluginUiRegistry = {
  "crm.home": lazy(() => import("./crm/CrmHomePage.js")),
  "crm.leads": lazy(() => import("./crm/LeadListPage.js")),
} satisfies Record<string, PluginPage>;

export type PluginRouteKey = keyof typeof pluginUiRegistry;
