import { Hono } from "hono";
import type { MetaAdsEnv } from "./env.js";
declare const app: Hono<MetaAdsEnv, import("hono/types").BlankSchema, "/">;
export declare function mapWithConcurrency<T, R>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]>;
export declare const metaAdsRoutes: import("hono/hono-base").HonoBase<MetaAdsEnv, {
    "/accounts": {
        $get: {
            output: {
                items: {
                    id: string;
                    name: string;
                    adAccountId: string;
                    enabled: boolean | number;
                    accountStatus?: number | null;
                    currency?: string | null;
                    timezoneName?: string | null;
                    createdByUserId: string;
                    version: number;
                    createdAt: import("hono/utils/types").JSONValue;
                    updatedAt: import("hono/utils/types").JSONValue;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/accounts/discover": {
        $get: {
            output: {
                items: {
                    id: string;
                    name: string;
                    account_status?: number | undefined;
                    currency?: string | undefined;
                    timezone_name?: string | undefined;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/accounts": {
        $post: {
            output: {
                id: string;
                name: string;
                adAccountId: string;
                enabled: boolean | number;
                accountStatus?: number | null;
                currency?: string | null;
                timezoneName?: string | null;
                createdByUserId: string;
                version: number;
                createdAt: import("hono/utils/types").JSONValue;
                updatedAt: import("hono/utils/types").JSONValue;
            };
            outputFormat: "json";
            status: 201;
            input: {};
        };
    };
} & {
    "/accounts/:accountId": {
        $patch: {
            output: {
                id: string;
                name: string;
                adAccountId: string;
                enabled: boolean | number;
                accountStatus?: number | null;
                currency?: string | null;
                timezoneName?: string | null;
                createdByUserId: string;
                version: number;
                createdAt: import("hono/utils/types").JSONValue;
                updatedAt: import("hono/utils/types").JSONValue;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    accountId: string;
                };
            };
        };
    };
} & {
    "/accounts/:accountId": {
        $delete: {
            output: null;
            outputFormat: "body";
            status: 204;
            input: {
                param: {
                    accountId: string;
                };
            };
        };
    };
} & {
    "/accounts/:accountId/test": {
        $post: {
            output: {
                ok: true;
                account: {
                    id: string;
                    name: string;
                    account_status?: number | undefined;
                    currency?: string | undefined;
                    timezone_name?: string | undefined;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    accountId: string;
                };
            };
        };
    };
} & {
    "/campaigns": {
        $get: {
            output: {
                items: {
                    id: string;
                    name: string;
                    status: string;
                    effective_status: string;
                    accountId: string;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/adsets": {
        $get: {
            output: {
                items: {
                    id: string;
                    name: string;
                    status: string;
                    effective_status: string;
                    campaign_id?: string | undefined;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/ads": {
        $get: {
            output: {
                items: {
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
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/insights": {
        $get: {
            output: {
                items: {
                    adId: string;
                    adName: string;
                    spend: number;
                    clicks: number;
                    impressions: number;
                    purchases: number;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/insights/query": {
        $post: {
            output: {
                items: {
                    adId: string;
                    adName: string;
                    spend: number;
                    clicks: number;
                    impressions: number;
                    purchases: number;
                }[];
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/status": {
        $post: {
            output: {
                ok: true;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
}, "/", "/status">;
export type MetaAdsAppType = typeof metaAdsRoutes;
export default app;
