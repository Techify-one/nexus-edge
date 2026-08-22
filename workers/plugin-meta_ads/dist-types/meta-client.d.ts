import type { MetaAdsBindings } from "./env.js";
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
    creative?: {
        id?: string | undefined;
        thumbnail_url?: string | undefined;
        image_url?: string | undefined;
    } | undefined;
};
export declare class MetaApiError extends Error {
    readonly code: string;
    readonly status: number;
    constructor(code: string, message: string, status?: number);
}
export declare const normalizeAccountId: (value: string) => string;
export declare const assertObjectId: (value: string) => string;
export declare function discoverAccounts(env: MetaAdsBindings): Promise<MetaAccount[]>;
export declare function inspectAccount(env: MetaAdsBindings, accountId: string): Promise<MetaAccount>;
export declare function listCampaigns(env: MetaAdsBindings, accountId: string, signal?: AbortSignal): Promise<MetaCampaign[]>;
export declare const listAdSets: (env: MetaAdsBindings, campaignId: string, signal?: AbortSignal) => Promise<MetaAdSet[]>;
export declare const listAds: (env: MetaAdsBindings, campaignId: string, signal?: AbortSignal) => Promise<MetaAd[]>;
export type MetaInsight = {
    ad_id: string;
    ad_name?: string | undefined;
    spend?: string | undefined;
    inline_link_clicks?: string | undefined;
    impressions?: string | undefined;
    actions?: Array<{
        action_type?: string | undefined;
        value?: string | undefined;
    }> | undefined;
};
export declare function listInsights(env: MetaAdsBindings, accountId: string, adIds: string[], since: string, until: string, signal?: AbortSignal): Promise<MetaInsight[]>;
export declare function getObjectAccountId(env: MetaAdsBindings, objectId: string): Promise<string>;
export declare function setObjectStatus(env: MetaAdsBindings, objectId: string, status: "ACTIVE" | "PAUSED"): Promise<void>;
export declare function validateDateRange(since: string, until: string): void;
export declare const extractMetaPurchases: (actions: MetaInsight["actions"]) => number;
