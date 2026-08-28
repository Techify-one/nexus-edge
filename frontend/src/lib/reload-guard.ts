type ReloadGuard = () => boolean;

const guards = new Map<string, ReloadGuard>();

export const registerReloadGuard = (
  id: string,
  guard: ReloadGuard,
): (() => void) => {
  guards.set(id, guard);
  return () => guards.delete(id);
};

export const isReloadGuarded = (): boolean =>
  [...guards.values()].some((guard) => guard());

export const publishUpdatePending = (): void => {
  window.dispatchEvent(new CustomEvent("app:update-pending"));
};
