const ACCOUNT_ID = /^act_\d{6,30}$/u;
const OBJECT_ID = /^\d{6,30}$/u;
const API_VERSION = /^v\d{1,2}\.\d{1,2}$/u;
export class MetaApiError extends Error {
    code;
    status;
    constructor(code, message, status = 502) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
export const normalizeAccountId = (value) => {
    const trimmed = String(value).trim();
    const normalized = trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
    if (!ACCOUNT_ID.test(normalized))
        throw new MetaApiError("INVALID_AD_ACCOUNT_ID", "The ad account ID must use the act_123456 format.", 400);
    return normalized;
};
export const assertObjectId = (value) => {
    const trimmed = String(value).trim();
    if (!OBJECT_ID.test(trimmed))
        throw new MetaApiError("INVALID_META_OBJECT_ID", "Invalid Meta object ID.", 400);
    return trimmed;
};
const apiBase = (env) => {
    const version = env.META_API_VERSION || "v25.0";
    if (!API_VERSION.test(version))
        throw new MetaApiError("META_API_VERSION_INVALID", "The configured Meta API version is invalid.", 500);
    return `https://graph.facebook.com/${version}`;
};
const accessToken = (env) => {
    if (!env.META_ACCESS_TOKEN)
        throw new MetaApiError("META_TOKEN_NOT_CONFIGURED", "The Meta access token is not configured for this plugin.", 503);
    return env.META_ACCESS_TOKEN;
};
const safeMetaMessage = (body, status) => {
    const error = body.error;
    const message = error?.error_user_msg || error?.error_user_title || error?.message;
    if (!message)
        return `Meta API request failed (${status}).`;
    return String(message)
        .replace(/[\r\n\t]+/gu, " ")
        .slice(0, 300);
};
async function requestJson(env, pathOrUrl, init = {}) {
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
    const body = (await response.json().catch(() => ({})));
    if (!response.ok || body.error) {
        const metaCode = Number(body.error?.code || 0);
        throw new MetaApiError(metaCode === 80004
            ? "META_RATE_LIMITED"
            : metaCode === 190
                ? "META_TOKEN_INVALID"
                : `META_API_${metaCode || response.status}`, safeMetaMessage(body, response.status), metaCode === 80004 ? 429 : 502);
    }
    return body;
}
async function getAll(env, path, params = {}, signal) {
    const first = new URL(`${apiBase(env)}${path}`);
    first.searchParams.set("limit", "100");
    for (const [key, value] of Object.entries(params))
        first.searchParams.set(key, value);
    const items = [];
    let next = first.toString();
    for (let page = 0; next && page < 50; page += 1) {
        const body = await requestJson(env, next, signal ? { signal } : {});
        if (Array.isArray(body.data))
            items.push(...body.data);
        next = body.paging?.next || null;
    }
    return items;
}
export async function discoverAccounts(env) {
    const accounts = await getAll(env, "/me/adaccounts", {
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
export async function inspectAccount(env, accountId) {
    const id = normalizeAccountId(accountId);
    const url = new URL(`${apiBase(env)}/${id}`);
    url.searchParams.set("fields", "account_id,name,account_status,currency,timezone_name");
    const account = await requestJson(env, url.toString());
    return {
        id: normalizeAccountId(account.id || account.account_id || id),
        name: account.name || id,
        account_status: account.account_status,
        currency: account.currency,
        timezone_name: account.timezone_name,
    };
}
export async function listCampaigns(env, accountId, signal) {
    const id = normalizeAccountId(accountId);
    const rows = await getAll(env, `/${id}/campaigns`, { fields: "id,name,status,effective_status" }, signal);
    return rows.map((row) => ({ ...row, accountId: id }));
}
export const listAdSets = (env, campaignId, signal) => getAll(env, `/${assertObjectId(campaignId)}/adsets`, {
    fields: "id,name,status,effective_status,campaign_id",
}, signal);
export const listAds = (env, campaignId, signal) => getAll(env, `/${assertObjectId(campaignId)}/ads`, {
    fields: "id,name,status,effective_status,campaign_id,adset_id,creative{id,thumbnail_url,image_url}",
}, signal);
export async function listInsights(env, accountId, adIds, period, signal) {
    const filtering = JSON.stringify([
        { field: "ad.id", operator: "IN", value: adIds.map(assertObjectId) },
    ]);
    const periodParams = period.kind === "maximum"
        ? { date_preset: "maximum" }
        : {
            time_range: JSON.stringify({
                since: period.since,
                until: period.until,
            }),
        };
    return getAll(env, `/${normalizeAccountId(accountId)}/insights`, {
        level: "ad",
        fields: "ad_id,ad_name,spend,inline_link_clicks,impressions,actions",
        ...periodParams,
        filtering,
    }, signal);
}
export async function getObjectAccountId(env, objectId) {
    const id = assertObjectId(objectId);
    const url = new URL(`${apiBase(env)}/${id}`);
    url.searchParams.set("fields", "id,account_id");
    const object = await requestJson(env, url.toString());
    if (!object.account_id)
        throw new MetaApiError("META_OBJECT_ACCOUNT_UNAVAILABLE", "The Meta object account could not be verified.", 502);
    return normalizeAccountId(object.account_id);
}
export async function setObjectStatus(env, objectId, status) {
    const form = new URLSearchParams({ status });
    await requestJson(env, `/${assertObjectId(objectId)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
    });
}
export function validateDateRange(since, until) {
    const pattern = /^\d{4}-\d{2}-\d{2}$/u;
    if (!pattern.test(since) || !pattern.test(until))
        throw new MetaApiError("INVALID_DATE_RANGE", "Dates must use the YYYY-MM-DD format.", 400);
    const start = Date.parse(`${since}T00:00:00.000Z`);
    const end = Date.parse(`${until}T00:00:00.000Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end)
        throw new MetaApiError("INVALID_DATE_RANGE", "The selected date range is invalid.", 400);
    if (end - start > 366 * 86_400_000)
        throw new MetaApiError("DATE_RANGE_TOO_LARGE", "Select a range of at most 366 days.", 400);
}
export const extractMetaPurchases = (actions) => {
    const values = new Map((actions || []).map((action) => [
        action.action_type || "",
        Number(action.value || 0),
    ]));
    return (values.get("purchase") ||
        values.get("offsite_conversion.fb_pixel_purchase") ||
        values.get("omni_purchase") ||
        0);
};
