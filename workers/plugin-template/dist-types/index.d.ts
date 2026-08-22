import { Hono } from "hono";
import type { PluginContext } from "@app/core-contract";
type Env = {
    Bindings: {
        DATABASE_PROVIDER: "d1" | "postgres";
    };
    Variables: {
        pluginContext: PluginContext;
    };
};
declare const app: Hono<Env, import("hono/types").BlankSchema, "/">;
export default app;
