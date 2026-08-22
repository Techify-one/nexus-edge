import {
  KeyRound,
  LayoutDashboard,
  Megaphone,
  LogOut,
  Menu,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Users,
  UserRoundCog,
  Webhook,
  Workflow,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { queryClient } from "../../app/query-client.js";
import { can } from "../../lib/ability.js";
import { api } from "../../lib/api/core-client.js";
import { APP_MARK, APP_NAME } from "../../lib/branding.js";
import { Button } from "../ui/index.js";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher.js";
import { useI18n, type TranslationKey } from "../../i18n/index.js";

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
  {
    to: "/app/crm/leads",
    label: "nav.leads",
    icon: Workflow,
    permission: "crm.lead.read",
    routeKey: "crm.leads",
  },
  {
    to: "/app/meta-ads",
    label: "nav.metaAds",
    icon: Megaphone,
    permission: "meta_ads.insight.read",
    routeKey: "meta_ads.dashboard",
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
] satisfies Array<{
  to: string;
  label: TranslationKey;
  icon: typeof LayoutDashboard;
  permission?: string;
  routeKey?: string;
}>;

export function AppShell() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try {
      const hidden = window.localStorage.getItem("nexus.sidebar.hidden");
      if (hidden !== null) return hidden === "true";
      return window.localStorage.getItem("nexus.sidebar.collapsed") === "true";
    } catch {
      return false;
    }
  });
  const navigate = useNavigate();
  const location = useLocation();
  const pluginNavigation = useQuery({
    queryKey: ["me", "plugin-navigation"],
    queryFn: () =>
      api<{ items: Array<{ routeKey: string }> }>(
        "/api/v1/me/plugin-navigation",
      ),
  });
  const activeRouteKeys = new Set(
    pluginNavigation.data?.items.map((item) => item.routeKey) ?? [],
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "nexus.sidebar.hidden",
        String(sidebarHidden),
      );
    } catch {
      // The menu still works when browser storage is unavailable.
    }
  }, [sidebarHidden]);
  const logout = async () => {
    await api("/api/auth/sign-out", { method: "POST" });
    queryClient.clear();
    navigate("/login", { replace: true });
  };
  const nav = () => (
    <>
      <div className="flex h-16 items-center gap-3 border-b px-5">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-indigo-600 font-black text-white">
          {APP_MARK}
        </div>
        <div>
          <div className="font-bold">{APP_NAME}</div>
          <div className="text-xs text-slate-500">Edge Runtime</div>
        </div>
      </div>
      <nav className="space-y-1 p-3" aria-label={t("nav.main")}>
        {items
          .filter(
            (item) =>
              (!item.permission || can(item.permission)) &&
              (!("routeKey" in item) || activeRouteKeys.has(item.routeKey)),
          )
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
    <div className="min-h-screen bg-slate-50">
      <aside
        aria-hidden={sidebarHidden}
        className={`fixed inset-y-0 left-0 z-30 hidden overflow-hidden bg-white transition-[width] duration-200 lg:block ${sidebarHidden ? "w-0 border-r-0" : "w-60 border-r"}`}
      >
        {!sidebarHidden && <div className="w-60">{nav()}</div>}
      </aside>
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
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-white/95 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              className="px-2 lg:hidden"
              onClick={() => setOpen(true)}
              aria-label={t("nav.openMenu")}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              className="hidden px-2 lg:inline-flex"
              onClick={() => setSidebarHidden((current) => !current)}
              aria-label={
                sidebarHidden ? t("nav.expandMenu") : t("nav.collapseMenu")
              }
              title={
                sidebarHidden ? t("nav.expandMenu") : t("nav.collapseMenu")
              }
            >
              {sidebarHidden ? (
                <PanelLeftOpen className="h-5 w-5" />
              ) : (
                <PanelLeftClose className="h-5 w-5" />
              )}
            </Button>
            <div>
              <p className="text-xs text-slate-500">{t("nav.panel")}</p>
              <p className="max-w-[55vw] truncate text-sm font-semibold">
                {location.pathname}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button variant="ghost" onClick={logout}>
              <LogOut className="h-4 w-4" />
              {t("nav.signOut")}
            </Button>
          </div>
        </header>
        <main
          className={`p-4 sm:p-6 ${location.pathname.startsWith("/app/meta-ads") ? "w-full max-w-none lg:p-5" : "mx-auto max-w-7xl lg:p-8"}`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
