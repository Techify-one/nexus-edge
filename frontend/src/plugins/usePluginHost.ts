import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { PluginHostV1, PluginTablePreferenceV1 } from "@nexus/plugin-sdk";
import { useI18n } from "../i18n/index.js";
import { api } from "../lib/api/core-client.js";
import { useTheme } from "../theme/index.js";
import type { RuntimePluginDescriptor } from "./runtime.js";

const safePluginPath = (pluginId: string, path: string): string => {
  const prefix = `/app/p/${pluginId}`;
  const candidate = path.startsWith(prefix)
    ? path
    : path.startsWith("/")
      ? `${prefix}${path}`
      : `${prefix}/${path}`;
  const normalized = new URL(candidate, window.location.origin);
  if (
    normalized.origin !== window.location.origin ||
    (normalized.pathname !== prefix &&
      !normalized.pathname.startsWith(`${prefix}/`))
  )
    throw new Error("PLUGIN_NAVIGATION_PATH_INVALID");
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
};

const scopedApiUrl = (pluginId: string, path: string): string => {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("PLUGIN_API_PATH_INVALID");
  const prefix = `/api/v1/p/${encodeURIComponent(pluginId)}`;
  const normalized = new URL(`${prefix}${path}`, window.location.origin);
  if (
    normalized.origin !== window.location.origin ||
    (normalized.pathname !== prefix &&
      !normalized.pathname.startsWith(`${prefix}/`))
  )
    throw new Error("PLUGIN_API_PATH_INVALID");
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
};

const coreApiUrl = (path: string): string => {
  if (!path.startsWith("/api/v1/") || path.startsWith("//"))
    throw new Error("CORE_API_PATH_INVALID");
  const normalized = new URL(path, window.location.origin);
  if (
    normalized.origin !== window.location.origin ||
    !normalized.pathname.startsWith("/api/v1/")
  )
    throw new Error("CORE_API_PATH_INVALID");
  return `${normalized.pathname}${normalized.search}${normalized.hash}`;
};

export const usePluginHost = (
  pluginId: string,
  descriptor?: RuntimePluginDescriptor,
): PluginHostV1 => {
  const navigate = useNavigate();
  const { locale } = useI18n();
  const { theme } = useTheme();
  return useMemo(
    () => ({
      apiVersion: 1,
      pluginId,
      locale,
      theme,
      permissions: descriptor?.permissions ?? [],
      api: (path, init = {}) => {
        try {
          return fetch(scopedApiUrl(pluginId, path), {
            ...init,
            credentials: "include",
            headers: new Headers(init.headers),
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      coreApi: (path, init = {}) => {
        try {
          return fetch(coreApiUrl(path), {
            ...init,
            credentials: "include",
            headers: new Headers(init.headers),
          });
        } catch (error) {
          return Promise.reject(error);
        }
      },
      navigate: (path, options) =>
        navigate(safePluginPath(pluginId, path), {
          replace: options?.replace ?? false,
        }),
      notify: ({ message, tone = "info" }) => {
        if (tone === "success") toast.success(message);
        else if (tone === "error") toast.error(message);
        else toast.info(message);
      },
      tablePreferences: {
        get: async (tableId) => {
          if (!tableId.startsWith(`plugin.${pluginId}.`))
            throw new Error("PLUGIN_TABLE_ID_INVALID");
          const response = await api<{
            config: PluginTablePreferenceV1 | null;
          }>(`/api/v1/me/table-preferences/${encodeURIComponent(tableId)}`);
          return response.config;
        },
        set: async (tableId, config) => {
          if (!tableId.startsWith(`plugin.${pluginId}.`))
            throw new Error("PLUGIN_TABLE_ID_INVALID");
          await api(
            `/api/v1/me/table-preferences/${encodeURIComponent(tableId)}`,
            {
              method: "PUT",
              body: JSON.stringify(config),
            },
          );
        },
      },
    }),
    [descriptor?.permissions, locale, navigate, pluginId, theme],
  );
};
