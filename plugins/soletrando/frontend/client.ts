import { getAppLocale } from "../../../frontend/src/i18n/index.js";

type ErrorEnvelope = {
  error?: { code?: string; message?: string; requestId?: string };
};

export class SoletrandoPublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function publicApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  headers.set("Accept-Language", getAppLocale());
  const response = await fetch(`/api/v1/public/p/soletrando${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
  const data = (await response.json()) as T & ErrorEnvelope;
  if (!response.ok && (data as T & { status?: string }).status === "retry")
    return data;
  if (!response.ok)
    throw new SoletrandoPublicApiError(
      response.status,
      data.error?.code ?? "HTTP_ERROR",
    );
  return data;
}
