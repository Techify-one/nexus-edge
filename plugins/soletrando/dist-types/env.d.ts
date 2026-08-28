import type { DatabasePort } from "@app/database";
import type { PluginContext, PluginInstallerContext, PluginPublicContext } from "@app/core-contract";
export type SoletrandoBindings = {
    DATABASE_PROVIDER: "d1" | "postgres";
    DB?: Env["DB"];
    HYPERDRIVE?: Hyperdrive;
    DATABASE_URL?: string;
    AI?: Env["AI"];
};
export type SoletrandoVariables = {
    db: DatabasePort;
    pluginContext?: PluginContext;
    publicContext?: PluginPublicContext;
    installerContext?: PluginInstallerContext;
};
export type SoletrandoEnv = {
    Bindings: SoletrandoBindings;
    Variables: SoletrandoVariables;
};
