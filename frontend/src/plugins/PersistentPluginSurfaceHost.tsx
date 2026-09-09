import { useEffect, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/core-client.js";
import {
  activatePluginRuntime,
  deactivateAllPluginRuntimes,
  type PluginRuntimeResponse,
  type RuntimePluginDescriptor,
} from "./runtime.js";
import { usePluginHost } from "./usePluginHost.js";

function DynamicPersistentSurface({
  descriptor,
}: {
  descriptor: RuntimePluginDescriptor;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const host = usePluginHost(descriptor.pluginId, descriptor);
  useEffect(() => {
    if (!rootRef.current) return;
    let cancelled = false;
    let dispose: (() => void | Promise<void>) | undefined;
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
    mountRoot.dataset.nexusPluginSurface = descriptor.pluginId;
    styleRoot.appendChild(mountRoot);
    void activatePluginRuntime(descriptor, host)
      .then(async (active) => {
        if (cancelled || !active.module.mountSurface) return;
        const mounted = await active.module.mountSurface({
          container: mountRoot,
          host,
          session: active.session,
        });
        dispose = mounted.dispose;
      })
      .catch(() => {
        if (!cancelled)
          host.notify({
            tone: "error",
            message:
              host.locale === "en"
                ? "A persistent plugin surface could not be loaded."
                : "Não foi possível carregar uma superfície persistente de plugin.",
          });
      });
    return () => {
      cancelled = true;
      if (dispose) void dispose();
      mountRoot.remove();
    };
  }, [descriptor, host]);
  return <div ref={rootRef} data-nexus-plugin-surface={descriptor.pluginId} />;
}

export function PersistentPluginSurfaceHost({
  children,
}: {
  children: ReactNode;
}) {
  const runtime = useQuery({
    queryKey: ["plugin-runtime"],
    queryFn: () => api<PluginRuntimeResponse>("/api/v1/plugin-runtime"),
  });
  useEffect(
    () => () => {
      void deactivateAllPluginRuntimes();
    },
    [],
  );
  return (
    <>
      {children}
      {(runtime.data?.plugins ?? [])
        .filter((plugin) => plugin.persistentSurface)
        .map((plugin) => (
          <DynamicPersistentSurface key={plugin.pluginId} descriptor={plugin} />
        ))}
    </>
  );
}
