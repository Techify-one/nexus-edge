import { hc } from "hono/client";
import type { CrmAppType } from "@app/plugin-crm/contract";
export const crmRpc = hc<CrmAppType>("/api/v1/p/crm", {
  init: { credentials: "include" },
});
