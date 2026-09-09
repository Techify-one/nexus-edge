import type { PluginModuleV1 } from "@nexus/plugin-sdk";

export type RuntimePluginDescriptor = {
  pluginId: string;
  name: string;
  version: string;
  releaseHash: string;
  entryUrl: string;
  styleUrls: string[];
  isolation: "shadow" | "light";
  persistentSurface: boolean;
  permissions: string[];
  localeUrl: string;
  routes: Array<{ routeKey: string; path: string }>;
  menu: Array<{ title: string; routeKey: string; path: string }>;
};

export type PluginRuntimeResponse = {
  hostApi: 1;
  plugins: RuntimePluginDescriptor[];
};

export const loadPluginModule = async (
  entryUrl: string,
): Promise<PluginModuleV1> => {
  const imported = (await import(/* @vite-ignore */ entryUrl)) as {
    default?: unknown;
  };
  const module = imported.default;
  if (
    !module ||
    typeof module !== "object" ||
    (typeof (module as { mountPage?: unknown }).mountPage !== "function" &&
      typeof (module as { mountPublicPage?: unknown }).mountPublicPage !==
        "function")
  )
    throw new Error("PLUGIN_MODULE_CONTRACT_INVALID");
  return module as PluginModuleV1;
};

type ActivePluginRuntime = {
  releaseHash: string;
  module: PluginModuleV1;
  session?: Awaited<ReturnType<NonNullable<PluginModuleV1["activate"]>>>;
};

const activeRuntimes = new Map<string, ActivePluginRuntime>();
const pendingRuntimes = new Map<string, Promise<ActivePluginRuntime>>();

export const activatePluginRuntime = async (
  descriptor: RuntimePluginDescriptor,
  host: Parameters<NonNullable<PluginModuleV1["activate"]>>[0],
): Promise<ActivePluginRuntime> => {
  const active = activeRuntimes.get(descriptor.pluginId);
  if (active?.releaseHash === descriptor.releaseHash) return active;
  const pending = pendingRuntimes.get(descriptor.pluginId);
  if (pending) {
    const resolved = await pending;
    if (resolved.releaseHash === descriptor.releaseHash) return resolved;
  }
  const activation = (async () => {
    const previous = activeRuntimes.get(descriptor.pluginId);
    if (previous?.module.deactivate) await previous.module.deactivate();
    const module = await loadPluginModule(descriptor.entryUrl);
    const session = module.activate ? await module.activate(host) : undefined;
    const next = { releaseHash: descriptor.releaseHash, module, session };
    activeRuntimes.set(descriptor.pluginId, next);
    return next;
  })();
  pendingRuntimes.set(descriptor.pluginId, activation);
  try {
    return await activation;
  } finally {
    if (pendingRuntimes.get(descriptor.pluginId) === activation)
      pendingRuntimes.delete(descriptor.pluginId);
  }
};

export const deactivateAllPluginRuntimes = async (): Promise<void> => {
  const runtimes = [...activeRuntimes.values()];
  activeRuntimes.clear();
  await Promise.allSettled(
    runtimes.map((runtime) => runtime.module.deactivate?.()),
  );
};
