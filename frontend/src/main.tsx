import { StrictMode, Suspense, lazy, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import {
  createBrowserRouter,
  Navigate,
  RouterProvider,
} from "react-router-dom";
import { AuthenticatedLayout } from "./app/AuthenticatedLayout.js";
import { AppProviders } from "./app/providers.js";
import { Skeleton } from "./components/ui/index.js";
import {
  AcceptInvitePage,
  HomeRedirect,
  LoginPage,
  SetupPage,
} from "./features/auth/pages.js";
import DashboardPage from "./features/dashboard.js";
import { pluginUiRegistry } from "./plugins/registry.js";
import "./styles/globals.css";

const UsersPage = lazy(() => import("./features/users/UsersPage.js"));
const GroupsPage = lazy(() => import("./features/groups/GroupsPage.js"));
const ApiKeysPage = lazy(() => import("./features/api-keys/ApiKeysPage.js"));
const WebhooksPage = lazy(() => import("./features/webhooks/WebhooksPage.js"));
const PluginsPage = lazy(() => import("./features/plugins/PluginsPage.js"));
const AuditPage = lazy(() => import("./features/audit/AuditPage.js"));

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

const router = createBrowserRouter([
  { path: "/", element: <HomeRedirect /> },
  { path: "/setup", element: <SetupPage /> },
  { path: "/login", element: <LoginPage /> },
  { path: "/accept-invite", element: <AcceptInvitePage /> },
  {
    path: "/app",
    element: <AuthenticatedLayout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "users", element: lazyElement(UsersPage) },
      { path: "groups", element: lazyElement(GroupsPage) },
      { path: "settings/api-keys", element: lazyElement(ApiKeysPage) },
      { path: "settings/webhooks", element: lazyElement(WebhooksPage) },
      { path: "plugins", element: lazyElement(PluginsPage) },
      {
        path: "plugins/:pluginId/operations/:operationId",
        element: lazyElement(PluginsPage),
      },
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
