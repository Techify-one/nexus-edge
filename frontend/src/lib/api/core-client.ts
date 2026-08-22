import { hc } from "hono/client";
import type { CoreAppType } from "@app/core-worker/contract";
import { getAppLocale, hasTranslation, translate } from "../../i18n/index.js";

export const coreRpc = hc<CoreAppType>("/api/v1", {
  init: { credentials: "include" },
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  headers.set("Accept-Language", getAppLocale());
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  const data = (await response.json()) as T & {
    error?: { code: string; message: string; requestId?: string };
  };
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("app:unauthenticated"));
    const errorKey = `errors.${data.error?.code ?? "HTTP_ERROR"}`;
    throw new ApiError(
      response.status,
      data.error?.code ?? "HTTP_ERROR",
      hasTranslation(errorKey)
        ? translate(errorKey)
        : translate("errors.fallback"),
      data.error?.requestId,
    );
  }
  return data;
}

export const idempotencyKey = (): string => crypto.randomUUID();

export async function recentReauthHeaders(
  message = translate("common.confirmPassword"),
): Promise<Record<string, string>> {
  const password = prompt(message);
  if (!password) throw new Error(translate("common.operationCancelled"));
  const reauth = await api<{ token: string }>("/api/v1/auth/reauth", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  return { "X-Reauth-Token": reauth.token };
}
