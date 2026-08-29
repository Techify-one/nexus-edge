const pluginRoot = (registeredPath: string): string | null => {
  const segments = registeredPath.split("/").filter(Boolean);
  if (segments[0] !== "app" || !segments[1]) return null;
  return `/app/${segments[1]}`;
};

/**
 * Nested plugin pages return to their plugin overview. The plugin overview
 * itself returns to the Core overview.
 */
export const resolvePluginBackTarget = (
  pathname: string,
  registeredPaths: Iterable<string>,
): string | undefined => {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  const roots = new Set(
    [...registeredPaths]
      .map(pluginRoot)
      .filter((root): root is string => Boolean(root)),
  );
  const root = [...roots].find(
    (candidate) =>
      normalized === candidate || normalized.startsWith(`${candidate}/`),
  );
  if (!root) return undefined;
  return normalized === root ? "/app" : root;
};
