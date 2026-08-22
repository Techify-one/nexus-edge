import type { DatabasePort } from "@app/database";
import { createId } from "@app/core-contract";

export type LeadInput = {
  name: string;
  email?: string | undefined;
  phone?: string | undefined;
  company?: string | undefined;
  status: "new" | "qualified" | "won" | "lost";
  notes?: string | undefined;
};
export type Lead = LeadInput & {
  id: string;
  ownerUserId: string;
  version: number;
  createdAt: unknown;
  updatedAt: unknown;
};

const dbTime = (db: DatabasePort, value = Date.now()) =>
  db.provider === "d1" ? value : new Date(value);

export class LeadRepository {
  constructor(private readonly db: DatabasePort) {}

  async list(limit: number, search?: string): Promise<Lead[]> {
    return this.db.query<Lead>(
      `SELECT id, name, email, phone, company, status, notes, owner_user_id AS "ownerUserId", version, created_at AS "createdAt", updated_at AS "updatedAt"
         FROM crm_leads WHERE (? IS NULL OR lower(name) LIKE lower(?) OR lower(COALESCE(company,'')) LIKE lower(?))
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
      [
        search ?? null,
        search ? `%${search}%` : null,
        search ? `%${search}%` : null,
        limit,
      ],
    );
  }

  get(id: string): Promise<Lead | null> {
    return this.db.first<Lead>(
      `SELECT id, name, email, phone, company, status, notes, owner_user_id AS "ownerUserId", version, created_at AS "createdAt", updated_at AS "updatedAt" FROM crm_leads WHERE id = ?`,
      [id],
    );
  }

  async create(
    input: LeadInput,
    userId: string,
    requestId: string,
  ): Promise<Lead> {
    const id = createId("lead");
    const activityId = createId("act");
    const now = dbTime(this.db);
    await this.db.atomic([
      {
        sql: `INSERT INTO crm_leads(id,name,email,phone,company,status,notes,owner_user_id,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,1,?,?)`,
        params: [
          id,
          input.name,
          input.email ?? null,
          input.phone ?? null,
          input.company ?? null,
          input.status,
          input.notes ?? null,
          userId,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO crm_activities(id,lead_id,type,body,actor_user_id,created_at) VALUES (?,?,'created',NULL,?,?)`,
        params: [activityId, id, userId, now],
      },
      {
        sql: `INSERT INTO audit_log(id,request_id,user_id,auth_method,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,'internal','crm.lead.created','crm.lead',?,'{}',?)`,
        params: [createId("aud"), requestId, userId, id, now],
      },
    ]);
    return (await this.get(id))!;
  }

  async update(
    id: string,
    input: Partial<LeadInput> & { version: number },
    userId: string,
    requestId: string,
  ): Promise<Lead | null> {
    const current = await this.get(id);
    if (!current || Number(current.version) !== input.version) return null;
    const next = { ...current, ...input };
    const now = dbTime(this.db);
    const result = await this.db.atomic([
      {
        sql: `UPDATE crm_leads SET name=?,email=?,phone=?,company=?,status=?,notes=?,version=version+1,updated_at=? WHERE id=? AND version=?`,
        params: [
          next.name,
          next.email ?? null,
          next.phone ?? null,
          next.company ?? null,
          next.status,
          next.notes ?? null,
          now,
          id,
          input.version,
        ],
      },
      {
        sql: `INSERT INTO crm_activities(id,lead_id,type,body,actor_user_id,created_at) VALUES (?,?,'updated',NULL,?,?)`,
        params: [createId("act"), id, userId, now],
      },
      {
        sql: `INSERT INTO audit_log(id,request_id,user_id,auth_method,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,'internal','crm.lead.updated','crm.lead',?,'{}',?)`,
        params: [createId("aud"), requestId, userId, id, now],
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
    const now = dbTime(this.db);
    const result = await this.db.atomic([
      { sql: "DELETE FROM crm_leads WHERE id = ?", params: [id] },
      {
        sql: `INSERT INTO audit_log(id,request_id,user_id,auth_method,action,resource_type,resource_id,metadata_json,created_at) VALUES (?,?,?,'internal','crm.lead.deleted','crm.lead',?,'{}',?)`,
        params: [createId("aud"), requestId, userId, id, now],
      },
    ]);
    return Boolean(result[0]?.rowsAffected);
  }
}
