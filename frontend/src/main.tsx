import { StrictMode, Suspense, lazy, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  isRouteErrorResponse,
  Navigate,
  RouterProvider,
  useRouteError,
} from "react-router-dom";
import { AuthenticatedLayout } from "./app/AuthenticatedLayout.js";
import { AppProviders } from "./app/providers.js";
import { Button, Skeleton } from "./components/ui/index.js";
import {
  AcceptInvitePage,
  HomeRedirect,
  LoginPage,
  SetupPage,
} from "./features/auth/pages.js";
import DashboardPage from "./features/dashboard.js";
import { useI18n } from "./i18n/index.js";
import { registerChunkRecovery } from "./lib/chunk-recovery.js";
import { pluginUiRegistry } from "./plugins/registry.js";
import "./styles/globals.css";

const UsersPage = lazy(() => import("./features/users/UsersPage.js"));
const GroupsPage = lazy(() => import("./features/groups/GroupsPage.js"));
const ApiKeysPage = lazy(() => import("./features/api-keys/ApiKeysPage.js"));
const WebhooksPage = lazy(() => import("./features/webhooks/WebhooksPage.js"));
const PluginsPage = lazy(() => import("./features/plugins/PluginsPage.js"));
const AuditPage = lazy(() => import("./features/audit/AuditPage.js"));

registerChunkRecovery();

const pending = (
  <div className="space-y-4">
    <Skeleton className="h-12" />
    <Skeleton className="h-72" />
  </div>
);
const lazyElement = (Component: ComponentType) => (
  <Suspense fallback={pending}>
    <Component />
  </Suspense>
);

const RouteErrorPage = () => {
  const { t } = useI18n();
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : t("errors.pageLoadDescription");

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <div className="w-full max-w-lg rounded-2xl border bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-bold text-slate-900">
          {t("errors.pageLoadTitle")}
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          {t("errors.pageLoadDescription")}
        </p>
        <p className="mt-3 break-words rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
          {detail}
        </p>
        <Button className="mt-5" onClick={() => window.location.reload()}>
          {t("errors.reloadPage")}
        </Button>
      </div>
    </main>
  );
};

const router = createBrowserRouter([
  { path: "/", element: <HomeRedirect /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/accept-invite", element: <AcceptInvitePage /> },
  {
    path: "/app",
    element: <AuthenticatedLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "users", element: lazyElement(UsersPage) },
      { path: "groups", element: lazyElement(GroupsPage) },
      { path: "settings/api-keys", element: lazyElement(ApiKeysPage) },
      { path: "settings/webhooks", element: lazyElement(WebhooksPage) },
      { path: "plugins", element: lazyElement(PluginsPage) },
      { path: "audit", element: lazyElement(AuditPage) },
      { path: "crm", element: lazyElement(pluginUiRegistry["crm.home"]) },
      {
        path: "crm/leads",
        element: lazyElement(pluginUiRegistry["crm.leads"]),
      },
      {
        path: "crm/leads/:leadId",
        element: lazyElement(pluginUiRegistry["crm.leads"]),
      },
      {
        path: "meta-ads",
        element: lazyElement(pluginUiRegistry["meta_ads.dashboard"]),
      },
      {
        path: "meta-ads/accounts",
        element: lazyElement(pluginUiRegistry["meta_ads.accounts"]),
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
