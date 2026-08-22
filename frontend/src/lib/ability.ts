import { createMongoAbility, type MongoAbility } from "@casl/ability";
import { unpackRules } from "@casl/ability/extra";

export type AppAbility = MongoAbility<[string, string]>;
export const ability = createMongoAbility<[string, string]>([]);
export const updateAbility = (packed: unknown): void => {
  ability.update(unpackRules(packed as never));
};
export const can = (permission: string): boolean => {
  const [namespace, resource, action] = permission.split(".");
  return Boolean(
    namespace &&
    resource &&
    action &&
    ability.can(action, `${namespace}.${resource}`),
  );
};
