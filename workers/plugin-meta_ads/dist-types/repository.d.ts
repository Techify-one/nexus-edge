import type { DatabasePort } from "@app/database";
import type { MetaAccount } from "./meta-client.js";
export type AdAccountRecord = {
    id: string;
    name: string;
    adAccountId: string;
    enabled: boolean | number;
    accountStatus?: number | null;
    currency?: string | null;
    timezoneName?: string | null;
    createdByUserId: string;
    version: number;
    createdAt: unknown;
    updatedAt: unknown;
};
export type AccountInput = {
    name: string;
    adAccountId: string;
    enabled: boolean;
};
export declare class AccountRepository {
    private readonly db;
    constructor(db: DatabasePort);
    list(): Promise<AdAccountRecord[]>;
    get(id: string): Promise<AdAccountRecord | null>;
    getByAdAccountId(adAccountId: string): Promise<AdAccountRecord | null>;
    enabledAccountIds(): Promise<Set<string>>;
    create(input: AccountInput, meta: MetaAccount, userId: string, requestId: string): Promise<AdAccountRecord>;
    update(id: string, input: AccountInput & {
        version: number;
    }, meta: MetaAccount, userId: string, requestId: string): Promise<AdAccountRecord | null>;
    delete(id: string, userId: string, requestId: string): Promise<boolean>;
    auditStatusChange(objectId: string, objectType: string, status: string, userId: string, requestId: string): Promise<void>;
}
