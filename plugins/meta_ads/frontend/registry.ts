import { lazy } from "react";

export const metaAdsPluginUiRegistry = {
  "meta_ads.home": lazy(() => import("./MetaAdsHomePage.js")),
  "meta_ads.dashboard": lazy(() => import("./MetaAdsDashboardPage.js")),
  "meta_ads.accounts": lazy(() => import("./MetaAdsAccountsPage.js")),
};

export const metaAdsPluginRoutePaths = {
  "meta_ads.home": "/app/meta-ads",
  "meta_ads.dashboard": "/app/meta-ads",
  "meta_ads.accounts": "/app/meta-ads/accounts",
};
