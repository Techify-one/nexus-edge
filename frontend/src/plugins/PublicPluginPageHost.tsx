import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { PluginPageMountV1, PluginPublicHostV1 } from "@nexus/plugin-sdk";
import { Button, Skeleton } from "../components/ui/index.js";
import { useI18n } from "../i18n/index.js";
import { useTheme } from "../theme/index.js";
import { loadPluginModule } from "./runtime.js";

type PublicRuntimeDescriptor = {
  pluginId: string;
  name: string;
  version: string;
  releaseHash: string;
  entryUrl: string;
  styleUrls: string[];
  isolation: "shadow" | "light";
  route: { routeKey: string; path: string };
};

const publicApiUrl = (pluginId: string, path: string): string => {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("PLUGIN_API_PATH_INVALID");
  const prefix = `/api/v1/public/p/${encodeURIComponent(pluginId)}`;
  const normalized = new URL(`${prefix}${path}`, window.location.origin);
  if (
    normalized.origin !== window.location.origin ||
    (normalized.pathname !== prefix &&
      !normalized.pathname.startsWith(`${prefix}/`))
  )
    throw new Error("PLUGIN_API_PATH_INVALID");
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
};

const safePublicPath = (path: string): string => {
  const normalized = new URL(path, window.location.origin);
  if (
    normalized.origin !== window.location.origin ||
    !normalized.pathname.startsWith("/") ||
    normalized.pathname.startsWith("/api/") ||
    normalized.pathname.startsWith("/app/")
  )
    throw new Error("PLUGIN_NAVIGATION_PATH_INVALID");
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
};

export function PublicPluginPageHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const { locale, t } = useI18n();
  const { theme } = useTheme();
  const rootRef = useRef<HTMLDivElement>(null);
  const [descriptor, setDescriptor] = useState<PublicRuntimeDescriptor | null>(
    null,
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const host = useMemo<PluginPublicHostV1 | null>(
    () =>
      descriptor
        ? {
            apiVersion: 1,
            pluginId: descriptor.pluginId,
            locale,
            theme,
            permissions: [],
            api: (path, init = {}) => {
              try {
                return fetch(publicApiUrl(descriptor.pluginId, path), {
                  ...init,
                  credentials: "omit",
                  headers: new Headers(init.headers),
                });
              } catch (error) {
                return Promise.reject(error);
              }
            },
            navigate: (path, options) =>
              navigate(safePublicPath(path), {
                replace: options?.replace ?? false,
              }),
            notify: ({ message, tone = "info" }) => {
              if (tone === "success") toast.success(message);
              else if (tone === "error") toast.error(message);
              else toast.info(message);
            },
          }
        : null,
    [descriptor, locale, navigate, theme],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(null);
    setDescriptor(null);
    void fetch(
      `/api/v1/public/plugin-runtime?path=${encodeURIComponent(location.pathname)}`,
      { credentials: "omit", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("PUBLIC_PLUGIN_ROUTE_NOT_FOUND");
        const body = (await response.json()) as {
          plugin?: PublicRuntimeDescriptor;
        };
        if (!body.plugin) throw new Error("PUBLIC_PLUGIN_ROUTE_NOT_FOUND");
        setDescriptor(body.plugin);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setFailure(
            error instanceof Error
              ? error.message
              : "PUBLIC_PLUGIN_ROUTE_NOT_FOUND",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [location.pathname]);

  useEffect(() => {
    if (!descriptor || !host || !rootRef.current) return;
    let cancelled = false;
    let mount: PluginPageMountV1 | undefined;
    const wrapper = rootRef.current;
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
    const mountRoot = document.createElement("div");
    mountRoot.dataset.nexusPublicPlugin = descriptor.pluginId;
    styleRoot.appendChild(mountRoot);
    void loadPluginModule(descriptor.entryUrl)
      .then(async (module) => {
        if (cancelled || !module.mountPublicPage)
          throw new Error("PLUGIN_PUBLIC_MODULE_CONTRACT_INVALID");
        mount = await module.mountPublicPage({
          container: mountRoot,
          host,
          route: {
            pathname: location.pathname,
            relativePath: location.pathname,
            search: location.search,
            hash: location.hash,
          },
        });
      })
      .catch((error) => {
        if (!cancelled)
          setFailure(
            error instanceof Error ? error.message : "PLUGIN_UI_FAILED",
          );
      });
    return () => {
      cancelled = true;
      if (mount) void mount.dispose();
      mountRoot.remove();
    };
  }, [descriptor, host, location.hash, location.pathname, location.search]);

  if (loading) return <Skeleton className="m-6 h-80" />;
  if (failure || !descriptor)
    return (
      <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
        <section className="w-full max-w-lg rounded-2xl border bg-white p-8 text-center shadow-sm">
          <AlertTriangle className="mx-auto h-6 w-6 text-amber-600" />
          <h1 className="mt-3 text-xl font-bold">
            {t("errors.pageLoadTitle")}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {t("errors.pageLoadDescription")}
          </p>
          <Button className="mt-5" onClick={() => navigate("/")}>
            {t("common.back")}
          </Button>
        </section>
      </main>
    );
  return <div ref={rootRef} data-nexus-public-plugin={descriptor.pluginId} />;
}
