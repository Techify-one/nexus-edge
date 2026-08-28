import type { ReactNode } from "react";
import { persistentPluginSurfaceRegistry } from "./registry.js";

export function PersistentPluginSurfaceHost({
  installedPluginIds,
  children,
}: {
  installedPluginIds: string[];
  children: ReactNode;
}) {
  const registry: Record<
    string,
    (typeof persistentPluginSurfaceRegistry)[keyof typeof persistentPluginSurfaceRegistry]
  > = persistentPluginSurfaceRegistry;
  return installedPluginIds.reduceRight<ReactNode>((content, pluginId) => {
    const Surface = registry[pluginId];
    return Surface ? <Surface>{content}</Surface> : content;
  }, children);
}
