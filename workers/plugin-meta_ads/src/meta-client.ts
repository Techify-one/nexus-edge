import type { MetaAdsBindings } from "./env.js";

const ACCOUNT_ID = /^act_\d{6,30}$/u;
const OBJECT_ID = /^\d{6,30}$/u;
const API_VERSION = /^v\d{1,2}\.\d{1,2}$/u;

export type MetaAccount = {
  id: string;
  name: string;
  account_status?: number | undefined;
  currency?: string | undefined;
  timezone_name?: string | undefined;
};

export type MetaCampaign = {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  accountId: string;
};

export type MetaAdSet = {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  campaign_id?: string | undefined;
};

export type MetaAd = {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  campaign_id?: string | undefined;
  adset_id?: string | undefined;
  creative?:
    | {
        id?: string | undefined;
        thumbnail_url?: string | undefined;
        image_url?: string | undefined;
      }
    | undefined;
};

type MetaErrorBody = {
  error?: {
    message?: string;
    error_user_msg?: string;
    error_user_title?: string;
    code?: number;
  };
};

export class MetaApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

export const normalizeAccountId = (value: string): string => {
  const trimmed = String(value).trim();
  const normalized = trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
  if (!ACCOUNT_ID.test(normalized))
    throw new MetaApiError(
      "INVALID_AD_ACCOUNT_ID",
      "The ad account ID must use the act_123456 format.",
      400,
    );
  return normalized;
};

export const assertObjectId = (value: string): string => {
  const trimmed = String(value).trim();
  if (!OBJECT_ID.test(trimmed))
    throw new MetaApiError(
      "INVALID_META_OBJECT_ID",
      "Invalid Meta object ID.",
      400,
    );
  return trimmed;
};

const apiBase = (env: MetaAdsBindings): string => {
  const version = env.META_API_VERSION || "v25.0";
  if (!API_VERSION.test(version))
    throw new MetaApiError(
      "META_API_VERSION_INVALID",
      "The configured Meta API version is invalid.",
      500,
    );
  return `https://graph.facebook.com/${version}`;
};

const accessToken = (env: MetaAdsBindings): string => {
  if (!env.META_ACCESS_TOKEN)
    throw new MetaApiError(
      "META_TOKEN_NOT_CONFIGURED",
      "The Meta access token is not configured for this plugin.",
      503,
    );
  return env.META_ACCESS_TOKEN;
};

const safeMetaMessage = (body: MetaErrorBody, status: number): string => {
  const error = body.error;
  const message =
    error?.error_user_msg || error?.error_user_title || error?.message;
  if (!message) return `Meta API request failed (${status}).`;
  return String(message)
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 300);
};

async function requestJson<T>(
  env: MetaAdsBindings,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<T> {
  const target = pathOrUrl.startsWith("https://")
    ? new URL(pathOrUrl)
    : new URL(`${apiBase(env)}${pathOrUrl}`);
  target.searchParams.delete("access_token");
  const response = await fetch(target, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken(env)}`,
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & MetaErrorBody;
  if (!response.ok || body.error) {
    const metaCode = Number(body.error?.code || 0);
    throw new MetaApiError(
      metaCode === 80004
        ? "META_RATE_LIMITED"
        : metaCode === 190
          ? "META_TOKEN_INVALID"
          : `META_API_${metaCode || response.status}`,
      safeMetaMessage(body, response.status),
      metaCode === 80004 ? 429 : 502,
    );
  }
  return body;
}

async function getAll<T>(
  env: MetaAdsBindings,
  path: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<T[]> {
  const first = new URL(`${apiBase(env)}${path}`);
  first.searchParams.set("limit", "100");
  for (const [key, value] of Object.entries(params))
    first.searchParams.set(key, value);
  const items: T[] = [];
  let next: string | null = first.toString();
  for (let page = 0; next && page < 50; page += 1) {
    const body: { data?: T[]; paging?: { next?: string } } = await requestJson(
      env,
      next,
      signal ? { signal } : {},
    );
    if (Array.isArray(body.data)) items.push(...body.data);
    next = body.paging?.next || null;
  }
  return items;
}

export async function discoverAccounts(
  env: MetaAdsBindings,
): Promise<MetaAccount[]> {
  const accounts = await getAll<{
    id?: string;
    account_id?: string;
    name?: string;
    account_status?: number;
    currency?: string;
    timezone_name?: string;
  }>(env, "/me/adaccounts", {
    fields: "account_id,name,account_status,currency,timezone_name",
  });
  return accounts.map((account) => {
    const id = normalizeAccountId(account.id || account.account_id || "");
    return {
      id,
      name: account.name || id,
      account_status: account.account_status,
      currency: account.currency,
      timezone_name: account.timezone_name,
    };
  });
}

export async function inspectAccount(
  env: MetaAdsBindings,
  accountId: string,
): Promise<MetaAccount> {
  const id = normalizeAccountId(accountId);
  const url = new URL(`${apiBase(env)}/${id}`);
  url.searchParams.set(
    "fields",
    "account_id,name,account_status,currency,timezone_name",
  );
  const account = await requestJson<{
    id?: string;
    account_id?: string;
    name?: string;
    account_status?: number;
    currency?: string;
    timezone_name?: string;
  }>(env, url.toString());
  return {
    id: normalizeAccountId(account.id || account.account_id || id),
    name: account.name || id,
    account_status: account.account_status,
    currency: account.currency,
    timezone_name: account.timezone_name,
  };
}

export async function listCampaigns(
  env: MetaAdsBindings,
  accountId: string,
  signal?: AbortSignal,
): Promise<MetaCampaign[]> {
  const id = normalizeAccountId(accountId);
  const rows = await getAll<Omit<MetaCampaign, "accountId">>(
    env,
    `/${id}/campaigns`,
    { fields: "id,name,status,effective_status" },
    signal,
  );
  return rows.map((row) => ({ ...row, accountId: id }));
}

export const listAdSets = (
  env: MetaAdsBindings,
  campaignId: string,
  signal?: AbortSignal,
): Promise<MetaAdSet[]> =>
  getAll(
    env,
    `/${assertObjectId(campaignId)}/adsets`,
    {
      fields: "id,name,status,effective_status,campaign_id",
    },
    signal,
  );

export const listAds = (
  env: MetaAdsBindings,
  campaignId: string,
  signal?: AbortSignal,
): Promise<MetaAd[]> =>
  getAll(
    env,
    `/${assertObjectId(campaignId)}/ads`,
    {
      fields:
        "id,name,status,effective_status,campaign_id,adset_id,creative{id,thumbnail_url,image_url}",
    },
    signal,
  );

export type MetaInsight = {
  ad_id: string;
  ad_name?: string | undefined;
  spend?: string | undefined;
  inline_link_clicks?: string | undefined;
  impressions?: string | undefined;
  actions?:
    | Array<{
        action_type?: string | undefined;
        value?: string | undefined;
      }>
    | undefined;
};

export async function listInsights(
  env: MetaAdsBindings,
  accountId: string,
  adIds: string[],
  since: string,
  until: string,
  signal?: AbortSignal,
): Promise<MetaInsight[]> {
  const filtering = JSON.stringify([
    { field: "ad.id", operator: "IN", value: adIds.map(assertObjectId) },
  ]);
  return getAll(
    env,
    `/${normalizeAccountId(accountId)}/insights`,
    {
      level: "ad",
      fields: "ad_id,ad_name,spend,inline_link_clicks,impressions,actions",
      time_range: JSON.stringify({ since, until }),
      filtering,
    },
    signal,
  );
}

export async function getObjectAccountId(
  env: MetaAdsBindings,
  objectId: string,
): Promise<string> {
  const id = assertObjectId(objectId);
  const url = new URL(`${apiBase(env)}/${id}`);
  url.searchParams.set("fields", "id,account_id");
  const object = await requestJson<{ account_id?: string }>(
    env,
    url.toString(),
  );
  if (!object.account_id)
    throw new MetaApiError(
      "META_OBJECT_ACCOUNT_UNAVAILABLE",
      "The Meta object account could not be verified.",
      502,
    );
  return normalizeAccountId(object.account_id);
}

export async function setObjectStatus(
  env: MetaAdsBindings,
  objectId: string,
  status: "ACTIVE" | "PAUSED",
): Promise<void> {
  const form = new URLSearchParams({ status });
  await requestJson(env, `/${assertObjectId(objectId)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
}

export function validateDateRange(since: string, until: string): void {
  const pattern = /^\d{4}-\d{2}-\d{2}$/u;
  if (!pattern.test(since) || !pattern.test(until))
    throw new MetaApiError(
      "INVALID_DATE_RANGE",
      "Dates must use the YYYY-MM-DD format.",
      400,
    );
  const start = Date.parse(`${since}T00:00:00.000Z`);
  const end = Date.parse(`${until}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
    throw new MetaApiError(
      "INVALID_DATE_RANGE",
      "The selected date range is invalid.",
      400,
    );
  if (end - start > 366 * 86_400_000)
    throw new MetaApiError(
      "DATE_RANGE_TOO_LARGE",
      "Select a range of at most 366 days.",
      400,
    );
}

export const extractMetaPurchases = (
  actions: MetaInsight["actions"],
): number => {
  const values = new Map(
    (actions || []).map((action) => [
      action.action_type || "",
      Number(action.value || 0),
    ]),
  );
  return (
    values.get("purchase") ||
    values.get("offsite_conversion.fb_pixel_purchase") ||
    values.get("omni_purchase") ||
    0
  );
};
