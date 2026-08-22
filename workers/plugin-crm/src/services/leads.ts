import type { PluginContext } from "@app/core-contract";
import type { LeadInput } from "../repositories/leads.js";
import { LeadRepository } from "../repositories/leads.js";

export class LeadService {
  constructor(
    private readonly repository: LeadRepository,
    private readonly context: PluginContext,
  ) {}
  private require(permission: string): void {
    if (!this.context.permissions.includes(permission))
      throw new Error(`FORBIDDEN:${permission}`);
  }
  list(limit: number, search?: string) {
    this.require("crm.lead.read");
    return this.repository.list(limit, search);
  }
  get(id: string) {
    this.require("crm.lead.read");
    return this.repository.get(id);
  }
  create(input: LeadInput) {
    this.require("crm.lead.create");
    return this.repository.create(
      input,
      this.context.userId,
      this.context.requestId,
    );
  }
  update(id: string, input: Partial<LeadInput> & { version: number }) {
    this.require("crm.lead.update");
    return this.repository.update(
      id,
      input,
      this.context.userId,
      this.context.requestId,
    );
  }
  delete(id: string) {
    this.require("crm.lead.delete");
    return this.repository.delete(
      id,
      this.context.userId,
      this.context.requestId,
    );
  }
}
