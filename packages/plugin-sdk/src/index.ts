export type PluginThemeV1 = "light" | "dark";
export type PluginLocaleV1 = "pt-BR" | "en";

export type PluginRouteV1 = {
  pathname: string;
  relativePath: string;
  search: string;
  hash: string;
};

export type PluginTablePreferenceV1 = {
  version: 1;
  columnOrder: string[];
  columnVisibility: Record<string, boolean>;
  columnSizing: Record<string, number>;
  sorting: Array<{ id: string; desc: boolean }>;
};

export type PluginHostV1 = {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly locale: PluginLocaleV1;
  readonly theme: PluginThemeV1;
  readonly permissions: readonly string[];
  api(path: string, init?: RequestInit): Promise<Response>;
  coreApi(path: string, init?: RequestInit): Promise<Response>;
  navigate(path: string, options?: { replace?: boolean }): void;
  notify(input: { message: string; tone?: "success" | "error" | "info" }): void;
  tablePreferences: {
    get(tableId: string): Promise<PluginTablePreferenceV1 | null>;
    set(tableId: string, config: PluginTablePreferenceV1): Promise<void>;
  };
};

export type PluginPublicHostV1 = {
  readonly apiVersion: 1;
  readonly pluginId: string;
  readonly locale: PluginLocaleV1;
  readonly theme: PluginThemeV1;
  readonly permissions: readonly [];
  api(path: string, init?: RequestInit): Promise<Response>;
  navigate(path: string, options?: { replace?: boolean }): void;
  notify(input: { message: string; tone?: "success" | "error" | "info" }): void;
};

export type PluginSessionV1 = Record<string, unknown> | void;

export type PluginPageMountV1 = {
  dispose(): void | Promise<void>;
};

export type PluginModuleV1 = {
  activate?(host: PluginHostV1): Promise<PluginSessionV1> | PluginSessionV1;
  mountSurface?(input: {
    container: HTMLElement;
    host: PluginHostV1;
    session?: PluginSessionV1;
  }): Promise<PluginPageMountV1> | PluginPageMountV1;
  mountPage(input: {
    container: HTMLElement;
    host: PluginHostV1;
    route: PluginRouteV1;
    session?: PluginSessionV1;
  }): Promise<PluginPageMountV1> | PluginPageMountV1;
  mountPublicPage?(input: {
    container: HTMLElement;
    host: PluginPublicHostV1;
    route: PluginRouteV1;
  }): Promise<PluginPageMountV1> | PluginPageMountV1;
  deactivate?(): Promise<void> | void;
};

export const definePlugin = <T extends PluginModuleV1>(plugin: T): T => plugin;

export const assertPluginTableId = (
  pluginId: string,
  tableId: string,
): string => {
  if (!tableId.startsWith(`plugin.${pluginId}.`))
    throw new Error(`Table ID must start with plugin.${pluginId}.`);
  return tableId;
};

export type { PluginTableColumnV1, PluginTableLabelsV1 } from "./table.js";
export { mountConfigurableDataTable } from "./table.js";
