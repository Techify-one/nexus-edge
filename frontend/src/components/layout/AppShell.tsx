import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  ScrollText,
  Settings,
  Users,
  UserRoundCog,
  Webhook,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { queryClient } from "../../app/query-client.js";
import { can } from "../../lib/ability.js";
import { api } from "../../lib/api/core-client.js";
import { APP_MARK, APP_NAME } from "../../lib/branding.js";
import { Button } from "../ui/index.js";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher.js";
import { ThemeToggle } from "../theme/ThemeToggle.js";
import { useI18n, type TranslationKey } from "../../i18n/index.js";
import { resolvePluginBackTarget } from "../../plugins/navigation.js";
import type { PluginRuntimeResponse } from "../../plugins/runtime.js";

const items = [
  { to: "/app", label: "nav.overview", icon: LayoutDashboard },
  {
    to: "/app/users",
    label: "nav.users",
    icon: Users,
    permission: "core.user.read",
  },
  {
    to: "/app/groups",
    label: "nav.groups",
    icon: UserRoundCog,
    permission: "core.group.read",
  },
  { to: "/app/settings/api-keys", label: "nav.apiKeys", icon: KeyRound },
  {
    to: "/app/settings/webhooks",
    label: "nav.webhooks",
    icon: Webhook,
    permission: "core.webhook.read",
  },
  {
    to: "/app/plugins",
    label: "nav.plugins",
    icon: Package,
    permission: "core.plugin.read",
  },
  {
    to: "/app/audit",
    label: "nav.audit",
    icon: ScrollText,
    permission: "core.audit.read",
  },
  {
    to: "/app/settings/general",
    label: "nav.settings",
    icon: Settings,
    permission: "core.settings.read",
  },
] satisfies Array<{
  to: string;
  label: TranslationKey;
  icon: typeof LayoutDashboard;
  permission?: string;
}>;

export function resolveCoreNavigationLabel(pathname: string): TranslationKey {
  return (
    items.find(({ to }) =>
      to === "/app"
        ? pathname === to
        : pathname === to || pathname.startsWith(`${to}/`),
    )?.label ?? "nav.panel"
  );
}

export function AppShell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const pluginId =
    /^\/app\/p\/([a-z][a-z0-9_]{1,31})(?:\/|$)/u.exec(location.pathname)?.[1] ??
    null;
  const pluginRuntime = useQuery({
    queryKey: ["plugin-runtime"],
    queryFn: () => api<PluginRuntimeResponse>("/api/v1/plugin-runtime"),
    enabled: pluginId !== null,
  });
  const pluginName = pluginRuntime.data?.plugins.find(
    (plugin) => plugin.pluginId === pluginId,
  )?.name;
  const navigatePluginBack = () => {
    const pluginBackTarget = resolvePluginBackTarget(
      window.location.pathname,
      [],
    );
    if (!pluginBackTarget) return;
    void navigate(pluginBackTarget);
  };
  const isHome = location.pathname === "/app";
  const pageTitle = pluginId
    ? (pluginName ?? pluginId.replaceAll("_", " "))
    : t(resolveCoreNavigationLabel(location.pathname));
  const logout = async () => {
    await api("/api/auth/sign-out", { method: "POST" });
    queryClient.clear();
    navigate("/login", { replace: true });
  };
  const nav = () => (
    <>
      <div className="flex h-16 items-center border-b px-5 font-semibold">
        {t("nav.main")}
      </div>
      <nav className="space-y-1 p-3" aria-label={t("nav.main")}>
        {items
          .filter((item) => !item.permission || can(item.permission))
          .map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/app"}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium ${isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100"}`
              }
            >
              <Icon className="h-4.5 w-4.5 shrink-0" />
              {t(label)}
            </NavLink>
          ))}
      </nav>
    </>
  );
  return (
    <div className="app-shell min-h-screen bg-slate-50">
      <aside
        aria-hidden={sidebarHidden}
        className={`app-sidebar fixed inset-y-0 left-0 z-30 hidden overflow-hidden bg-white transition-[width] duration-200 lg:block ${sidebarHidden ? "w-0 border-r-0" : "w-60 border-r"}`}
      >
        {!sidebarHidden && <div className="w-60">{nav()}</div>}
      </aside>
      <button
        type="button"
        className={`fixed top-1/2 z-40 hidden h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border bg-white text-slate-500 shadow-sm transition-[left,color] duration-200 hover:text-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 lg:grid ${sidebarHidden ? "left-3.5" : "left-60"}`}
        onClick={() => setSidebarHidden((current) => !current)}
        aria-label={sidebarHidden ? t("nav.expandMenu") : t("nav.collapseMenu")}
        title={sidebarHidden ? t("nav.expandMenu") : t("nav.collapseMenu")}
      >
        {sidebarHidden ? (
          <ChevronRight className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronLeft className="h-4 w-4" aria-hidden />
        )}
      </button>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            className="absolute inset-0 bg-slate-950/30"
            onClick={() => setOpen(false)}
            aria-label={t("nav.closeMenu")}
          />
          <aside className="relative h-full w-72 bg-white shadow-xl">
            {nav()}
          </aside>
        </div>
      )}
      <div
        className={`transition-[padding] duration-200 ${sidebarHidden ? "lg:pl-0" : "lg:pl-60"}`}
      >
        <header className="app-header sticky top-0 z-20 flex h-16 min-w-0 items-center justify-between gap-3 border-b bg-white/95 px-4 backdrop-blur sm:px-6">
          <div className="flex shrink-0 items-center gap-3">
            {!pluginId && (
              <Button
                variant="ghost"
                className="px-2"
                onClick={() => {
                  if (window.matchMedia("(min-width: 1024px)").matches) {
                    setSidebarHidden((current) => !current);
                  } else {
                    setOpen((current) => !current);
                  }
                }}
                aria-label={
                  sidebarHidden ? t("nav.openMenu") : t("nav.closeMenu")
                }
              >
                <Menu className="h-5 w-5" />
              </Button>
            )}
            {pluginId && (
              <Button
                type="button"
                variant="ghost"
                className="px-2"
                onClick={navigatePluginBack}
                aria-label={t("common.back")}
                title={t("common.back")}
              >
                <ArrowLeft className="h-4 w-4" />
                {t("common.back")}
              </Button>
            )}
            {isHome ? (
              <div className="flex items-center gap-2.5">
                <span
                  className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 font-black text-white"
                  aria-hidden
                >
                  {APP_MARK}
                </span>
                <span className="text-sm font-bold text-slate-700">
                  {APP_NAME}
                </span>
              </div>
            ) : (
              <p
                data-plugin-header-title={pluginId ?? undefined}
                className="text-sm font-semibold text-slate-700"
              >
                {pageTitle}
              </p>
            )}
          </div>
          {pluginId && (
            <div
              key={pluginId}
              data-nexus-plugin-header-nav={pluginId}
              className="min-w-0 flex-1 overflow-x-auto"
            />
          )}
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle />
            <LanguageSwitcher />
            <Button
              variant="ghost"
              onClick={logout}
              aria-label={t("nav.signOut")}
              title={t("nav.signOut")}
            >
              <LogOut className="h-4 w-4" />
              <span className={pluginId ? "hidden xl:inline" : undefined}>
                {t("nav.signOut")}
              </span>
            </Button>
          </div>
        </header>
        <main
          className={`p-4 sm:p-5 ${location.pathname.startsWith("/app/p/") ? "w-full max-w-none lg:p-5" : "mx-auto max-w-7xl lg:p-6"}`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
