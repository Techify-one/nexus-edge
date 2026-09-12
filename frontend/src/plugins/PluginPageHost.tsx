import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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

  useEffect(() => {
    if (!descriptor || !rootRef.current || recoveryMode) return;
    let cancelled = false;
    let mount: PluginPageMountV1 | undefined;
    let mountRoot: HTMLElement | undefined;
    const start = async () => {
      try {
        setFailure(null);
        const wrapper = rootRef.current!;
        wrapper.replaceChildren();
        const styleRoot =
          descriptor.isolation === "shadow"
            ? (wrapper.shadowRoot ?? wrapper.attachShadow({ mode: "open" }))
            : wrapper;
        styleRoot.replaceChildren();
        const append = (node: Node) => {
          if (styleRoot instanceof ShadowRoot) styleRoot.appendChild(node);
          else styleRoot.appendChild(node);
        };
        for (const url of descriptor.styleUrls) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = url;
          append(link);
        }
        mountRoot = document.createElement("div");
        mountRoot.dataset.nexusPlugin = descriptor.pluginId;
        append(mountRoot);
        const active = await activatePluginRuntime(descriptor, host);
        if (cancelled) return;
        mount = await active.module.mountPage({
          container: mountRoot,
          host,
          route: {
            pathname: location.pathname,
            relativePath:
              location.pathname.slice(`/app/p/${pluginId}`.length) || "/",
            search: location.search,
            hash: location.hash,
          },
          session: active.session,
        });
      } catch (error) {
        if (!cancelled)
          setFailure(
            error instanceof Error ? error.message : "PLUGIN_UI_FAILED",
          );
      }
    };
    void start();
    return () => {
      cancelled = true;
      if (mount) void mount.dispose();
      mountRoot?.remove();
    };
  }, [
    descriptor,
    host,
    location.hash,
    location.pathname,
    location.search,
    pluginId,
    recoveryMode,
  ]);

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
