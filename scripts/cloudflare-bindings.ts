export type WorkerBinding = Record<string, unknown> & {
  name: string;
  type: string;
};

/**
 * The settings read API returns binding details that are not a valid write
 * payload (notably secret bindings without their values). Keep existing
 * bindings by name and write only the dynamic service bindings explicitly.
 */
export function bindingsForServiceRestore(
  current: WorkerBinding[],
  services: WorkerBinding[],
): WorkerBinding[] {
  const replaced = new Set(services.map((binding) => binding.name));
  const inherited = current
    .filter((binding) => !replaced.has(binding.name))
    .map((binding) => ({ type: "inherit", name: binding.name }));
  const restored = services.map((binding) => {
    if (binding.type !== "service" || typeof binding.service !== "string")
      throw new Error(
        `Binding ${binding.name} is not a writable service binding.`,
      );
    return {
      type: "service",
      name: binding.name,
      service: binding.service,
    };
  });
  return [...inherited, ...restored];
}
