import { createId } from "@app/core-contract";
const dbTime = (db, value = Date.now()) => db.provider === "d1" ? value : new Date(value);
const dbBoolean = (db, value) => db.provider === "d1" ? (value ? 1 : 0) : value;
const normalize = (row) => ({
    ...row,
    enabled: Boolean(row.enabled),
    accountStatus: row.accountStatus === null || row.accountStatus === undefined
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
    db;
    constructor(db) {
        this.db = db;
    }
    async list() {
        const rows = await this.db.query(`${select} ORDER BY enabled DESC, lower(name), ad_account_id`);
        return rows.map(normalize);
    }
    async get(id) {
        const row = await this.db.first(`${select} WHERE id = ?`, [
            id,
        ]);
        return row ? normalize(row) : null;
    }
    async getByAdAccountId(adAccountId) {
        const row = await this.db.first(`${select} WHERE ad_account_id = ?`, [adAccountId]);
        return row ? normalize(row) : null;
    }
    async enabledAccountIds() {
        const rows = await this.db.query(`SELECT ad_account_id AS "adAccountId" FROM meta_ads_accounts WHERE enabled = ?`, [dbBoolean(this.db, true)]);
        return new Set(rows.map((row) => row.adAccountId));
    }
    async create(input, meta, userId, requestId) {
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
        return (await this.get(id));
    }
    async update(id, input, meta, userId, requestId) {
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
        if (!result[0]?.rowsAffected)
            return null;
        return this.get(id);
    }
    async delete(id, userId, requestId) {
        const account = await this.get(id);
        if (!account)
            return false;
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
    async auditStatusChange(objectId, objectType, status, userId, requestId) {
        await this.db.execute(`INSERT INTO audit_log(
        id,request_id,user_id,auth_method,action,resource_type,resource_id,
        metadata_json,created_at
      ) VALUES (?,?,?,'internal',?,'meta_ads.object',?,?,?)`, [
            createId("aud"),
            requestId,
            userId,
            `meta_ads.${objectType}.status_updated`,
            objectId,
            JSON.stringify({ status }),
            dbTime(this.db),
        ]);
    }
}
