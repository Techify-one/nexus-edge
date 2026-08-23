import { lazy } from "react";

export const crmPluginUiRegistry = {
  "crm.home": lazy(() => import("./CrmHomePage.js")),
  "crm.leads": lazy(() => import("./LeadListPage.js")),
};

export const crmPluginRoutePaths = {
  "crm.home": "/app/crm",
  "crm.leads": "/app/crm/leads",
};
