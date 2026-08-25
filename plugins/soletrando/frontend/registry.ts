import { lazy } from "react";

export const soletrandoPluginUiRegistry = {
  "soletrando.children": lazy(() => import("./ChildrenPage.js")),
};

export const soletrandoPluginRoutePaths = {
  "soletrando.children": "/app/soletrando",
};

export const SoletrandoChildDetailPage = lazy(
  () => import("./ChildDetailPage.js"),
);

export const SoletrandoPracticePage = lazy(() => import("./PracticePage.js"));
