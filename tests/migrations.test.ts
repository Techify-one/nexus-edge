import { describe, expect, it } from "vitest";
import {
  migrationStatements,
  splitSqlStatements,
  validateAdditiveMigration,
} from "../workers/core/src/installer/migrations.js";

describe("plugin migrations", () => {
  it("splits statements without breaking semicolons inside literals", () =>
    expect(
      splitSqlStatements(
        "CREATE TABLE crm_x(v TEXT DEFAULT ';'); CREATE INDEX crm_x_i ON crm_x(v);",
      ),
    ).toHaveLength(2));
  it("accepts only prefixed additive DDL", () =>
    expect(() =>
      validateAdditiveMigration(
        "ALTER TABLE crm_leads ADD COLUMN source TEXT",
        "crm_",
      ),
    ).not.toThrow());
  it("allows referential actions inside additive table definitions", () =>
    expect(() =>
      validateAdditiveMigration(
        "CREATE TABLE crm_activities(id TEXT PRIMARY KEY, lead_id TEXT REFERENCES crm_leads(id) ON DELETE CASCADE)",
        "crm_",
      ),
    ).not.toThrow());
  it("rejects DROP and tables outside the namespace", () => {
    expect(() =>
      validateAdditiveMigration("DROP TABLE crm_leads", "crm_"),
    ).toThrow();
    expect(() =>
      validateAdditiveMigration("CREATE TABLE users(id TEXT)", "crm_"),
    ).toThrow();
  });
  it("requires ordered semantic IDs", () =>
    expect(
      migrationStatements(
        {
          "0002_more": "CREATE TABLE crm_b(id TEXT)",
          "0001_init": "CREATE TABLE crm_a(id TEXT)",
        },
        "crm_",
      ).map((item) => item.migrationId),
    ).toEqual(["0001_init", "0002_more"]));
});
