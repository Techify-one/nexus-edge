import type { DatabasePort } from "@app/database";
import { createId } from "@app/core-contract";
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

const dbTime = (db: DatabasePort, value = Date.now()) =>
  db.provider === "d1" ? value : new Date(value);

const dbBoolean = (db: DatabasePort, value: boolean) =>
  db.provider === "d1" ? (value ? 1 : 0) : value;

const normalize = (row: AdAccountRecord): AdAccountRecord => ({
  ...row,
  enabled: Boolean(row.enabled),
  accountStatus:
    row.accountStatus === null || row.accountStatus === undefined
      ? null
      : Number(row.accountStatus),
  version: Number(row.version),
});

const select = `SELECT id, name, ad_account_id AS "adAccountId", enabled,
  account_status AS "accountStatus", currency, timezone_name AS "timezoneName",
  created_by_user_id AS "createdByUserId", version,
  created_at AS "createdAt", updated_at AS "updatedAt"
  FROM meta_ads_accounts`;

export class AccountRepository {
  constructor(private readonly db: DatabasePort) {}

  async list(): Promise<AdAccountRecord[]> {
    const rows = await this.db.query<AdAccountRecord>(
      `${select} ORDER BY enabled DESC, lower(name), ad_account_id`,
    );
    return rows.map(normalize);
  }

  async get(id: string): Promise<AdAccountRecord | null> {
    const row = await this.db.first<AdAccountRecord>(`${select} WHERE id = ?`, [
      id,
    ]);
    return row ? normalize(row) : null;
  }

  async getByAdAccountId(adAccountId: string): Promise<AdAccountRecord | null> {
    const row = await this.db.first<AdAccountRecord>(
      `${select} WHERE ad_account_id = ?`,
      [adAccountId],
    );
    return row ? normalize(row) : null;
  }

  async enabledAccountIds(): Promise<Set<string>> {
    const rows = await this.db.query<{ adAccountId: string }>(
      `SELECT ad_account_id AS "adAccountId" FROM meta_ads_accounts WHERE enabled = ?`,
      [dbBoolean(this.db, true)],
    );
    return new Set(rows.map((row) => row.adAccountId));
  }

  async create(
    input: AccountInput,
    meta: MetaAccount,
    userId: string,
    requestId: string,
  ): Promise<AdAccountRecord> {
    const id = createId("maa");
    const now = dbTime(this.db);
    await this.db.atomic([
      {
        sql: `INSERT INTO meta_ads_accounts(
          id,name,ad_account_id,enabled,account_status,currency,timezone_name,
          created_by_user_id,version,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
        params: [
          id,
          input.name,
          input.adAccountId,
          dbBoolean(this.db, input.enabled),
          meta.account_status ?? null,
          meta.currency ?? null,
          meta.timezone_name ?? null,
          userId,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO audit_log(
          id,request_id,user_id,auth_method,action,resource_type,resource_id,
          metadata_json,created_at
        ) VALUES (?,?,?,'internal','meta_ads.account.created','meta_ads.account',?,?,?)`,
        params: [
          createId("aud"),
          requestId,
          userId,
          id,
          JSON.stringify({ adAccountId: input.adAccountId }),
          now,
        ],
      },
    ]);
    return (await this.get(id))!;
  }

  async update(
    id: string,
    input: AccountInput & { version: number },
    meta: MetaAccount,
    userId: string,
    requestId: string,
  ): Promise<AdAccountRecord | null> {
    const now = dbTime(this.db);
    const result = await this.db.atomic([
      {
        sql: `UPDATE meta_ads_accounts
          SET name=?, ad_account_id=?, enabled=?, account_status=?, currency=?,
              timezone_name=?, version=version+1, updated_at=?
          WHERE id=? AND version=?`,
        params: [
          input.name,
          input.adAccountId,
          dbBoolean(this.db, input.enabled),
          meta.account_status ?? null,
          meta.currency ?? null,
          meta.timezone_name ?? null,
          now,
          id,
          input.version,
        ],
      },
      {
        sql: `INSERT INTO audit_log(
          id,request_id,user_id,auth_method,action,resource_type,resource_id,
          metadata_json,created_at
        ) VALUES (?,?,?,'internal','meta_ads.account.updated','meta_ads.account',?,?,?)`,
        params: [
          createId("aud"),
          requestId,
          userId,
          id,
          JSON.stringify({ adAccountId: input.adAccountId }),
          now,
        ],
      },
    ]);
    if (!result[0]?.rowsAffected) return null;
    return this.get(id);
  }

  async delete(
    id: string,
    userId: string,
    requestId: string,
  ): Promise<boolean> {
    const account = await this.get(id);
    if (!account) return false;
    const now = dbTime(this.db);
    const result = await this.db.atomic([
      { sql: "DELETE FROM meta_ads_accounts WHERE id = ?", params: [id] },
      {
        sql: `INSERT INTO audit_log(
          id,request_id,user_id,auth_method,action,resource_type,resource_id,
          metadata_json,created_at
        ) VALUES (?,?,?,'internal','meta_ads.account.deleted','meta_ads.account',?,?,?)`,
        params: [
          createId("aud"),
          requestId,
          userId,
          id,
          JSON.stringify({ adAccountId: account.adAccountId }),
          now,
        ],
      },
    ]);
    return Boolean(result[0]?.rowsAffected);
  }

  async auditStatusChange(
    objectId: string,
    objectType: string,
    status: string,
    userId: string,
    requestId: string,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO audit_log(
        id,request_id,user_id,auth_method,action,resource_type,resource_id,
        metadata_json,created_at
      ) VALUES (?,?,?,'internal',?,'meta_ads.object',?,?,?)`,
      [
        createId("aud"),
        requestId,
        userId,
        `meta_ads.${objectType}.status_updated`,
        objectId,
        JSON.stringify({ status }),
        dbTime(this.db),
      ],
    );
  }
}
