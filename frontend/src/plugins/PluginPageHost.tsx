import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import type { PluginPageMountV1 } from "@nexus/plugin-sdk";
import { Button, Skeleton } from "../components/ui/index.js";
import { useI18n } from "../i18n/index.js";
import {
  activatePluginRuntime,
  type PluginRuntimeResponse,
} from "./runtime.js";
import { api } from "../lib/api/core-client.js";
import { usePluginHost } from "./usePluginHost.js";

export function PluginPageHost() {
  const { pluginId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const recoveryMode =
    new URLSearchParams(location.search).get("core-recovery") === "1";
  const runtime = useQuery({
    queryKey: ["plugin-runtime"],
    queryFn: () => api<PluginRuntimeResponse>("/api/v1/plugin-runtime"),
    enabled: !recoveryMode,
  });
  const descriptor = runtime.data?.plugins.find(
    (plugin) => plugin.pluginId === pluginId,
  );
  const host = usePluginHost(pluginId, descriptor);

  const route = useMemo(
    () => ({
      pathname: location.pathname,
      relativePath: location.pathname.slice(`/app/p/${pluginId}`.length) || "/",
      search: location.search,
      hash: location.hash,
    }),
    [location.pathname, location.search, location.hash, pluginId],
  );
  const latestRoute = useRef(route);
  latestRoute.current = route;
  const reconcileRoute = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!descriptor || !rootRef.current || recoveryMode) return;
    const wrapper = rootRef.current;
    let cancelled = false;
    let running = false;
    let mount: PluginPageMountV1 | undefined;
    let mountRoot: HTMLElement | undefined;
    let appliedRoute: typeof route | undefined;
    const start = async () => {
      if (running || cancelled) return;
      running = true;
      try {
        setFailure(null);
        while (!cancelled && appliedRoute !== latestRoute.current) {
          const nextRoute = latestRoute.current;
          if (mount?.updateRoute) {
            await mount.updateRoute(nextRoute);
            appliedRoute = nextRoute;
            continue;
          }
          if (mount) {
            const previous = mount;
            mount = undefined;
            await previous.dispose();
            if (cancelled) return;
          }
          wrapper.replaceChildren();
          const styleRoot =
            descriptor.isolation === "shadow"
              ? (wrapper.shadowRoot ?? wrapper.attachShadow({ mode: "open" }))
              : wrapper;
          styleRoot.replaceChildren();
          for (const url of descriptor.styleUrls) {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = url;
            styleRoot.appendChild(link);
          }
          mountRoot = document.createElement("div");
          mountRoot.dataset.nexusPlugin = descriptor.pluginId;
          styleRoot.appendChild(mountRoot);
          const active = await activatePluginRuntime(descriptor, host);
          if (cancelled) return;
          const created = await active.module.mountPage({
            container: mountRoot,
            host,
            route: nextRoute,
            session: active.session,
          });
          if (cancelled) {
            await created.dispose();
            return;
          }
          mount = created;
          appliedRoute = nextRoute;
        }
      } catch (error) {
        if (!cancelled)
          setFailure(
            error instanceof Error ? error.message : "PLUGIN_UI_FAILED",
          );
      } finally {
        running = false;
      }
    };
    const reconcile = () => void start();
    reconcileRoute.current = reconcile;
    reconcile();
    return () => {
      cancelled = true;
      if (reconcileRoute.current === reconcile) reconcileRoute.current = null;
      if (mount) void Promise.resolve(mount.dispose()).catch(() => {});
      mountRoot?.remove();
    };
  }, [descriptor, host, pluginId, recoveryMode]);

  useEffect(() => {
    reconcileRoute.current?.();
  }, [route]);

  if (recoveryMode)
    return (
      <section className="rounded-2xl border border-amber-300 bg-amber-50 p-6 text-amber-950">
        <h1 className="text-lg font-semibold">
          {t("plugins.recoveryModeTitle")}
        </h1>
        <p className="mt-2 text-sm">{t("plugins.recoveryModeDescription")}</p>
        <Button
          className="mt-4"
          onClick={() => navigate("/app/plugins/installed", { replace: true })}
        >
          {t("nav.plugins")}
        </Button>
      </section>
    );
  if (runtime.isPending) return <Skeleton className="h-80" />;
  if (runtime.isError || !descriptor)
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-950">
        <AlertTriangle className="h-6 w-6" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">
          {t("plugins.dynamicUnavailableTitle")}
        </h1>
        <p className="mt-2 text-sm">
          {t("plugins.dynamicUnavailableDescription")}
        </p>
        <Button
          className="mt-4"
          variant="secondary"
          onClick={() => void runtime.refetch()}
        >
          <RotateCcw className="h-4 w-4" />
          {t("plugins.runtimeCredentialRetry")}
        </Button>
      </section>
    );
  if (failure)
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-950">
        <AlertTriangle className="h-6 w-6" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">
          {t("plugins.dynamicFailedTitle")}
        </h1>
        <p className="mt-2 break-all text-sm">{failure}</p>
        <div className="mt-4 flex gap-2">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            <RotateCcw className="h-4 w-4" />
            {t("errors.reloadPage")}
          </Button>
          <Button
            onClick={() => navigate(`/app/p/${pluginId}?core-recovery=1`)}
          >
            {t("plugins.openRecoveryMode")}
          </Button>
        </div>
      </section>
    );
  return <div ref={rootRef} className="min-h-64" />;
}
