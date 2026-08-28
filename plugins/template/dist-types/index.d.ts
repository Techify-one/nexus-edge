import { Hono } from "hono";
import type { PluginContext, PluginInstallerContext } from "@app/core-contract";
type Env = {
    Bindings: {
        DATABASE_PROVIDER: "d1" | "postgres";
    };
    Variables: {
        pluginContext?: PluginContext;
        installerContext?: PluginInstallerContext;
    };
};
declare const app: Hono<Env, import("hono/types").BlankSchema, "/">;
export default app;
