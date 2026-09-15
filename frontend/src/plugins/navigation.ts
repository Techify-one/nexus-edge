const pluginRoot = (registeredPath: string): string | null => {
  const segments = registeredPath.split("/").filter(Boolean);
  if (segments[0] !== "app" || !segments[1]) return null;
  return `/app/${segments[1]}`;
};

const parentWithinPlugin = (pathname: string, root: string): string => {
  if (pathname === root) return "/app";
  const parent = pathname.slice(0, pathname.lastIndexOf("/"));
  return parent.length >= root.length ? parent : root;
};

/** Plugin routes return one URL level at a time, then return to Core. */
export const resolvePluginBackTarget = (
  pathname: string,
  registeredPaths: Iterable<string>,
): string | undefined => {
  const normalized = pathname.replace(/\/+$/u, "") || "/";
  const dynamic = /^\/app\/p\/([a-z][a-z0-9_]{1,31})(?:\/|$)/u.exec(normalized);
  if (dynamic) {
    const root = `/app/p/${dynamic[1]}`;
    return parentWithinPlugin(normalized, root);
  }
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
  return parentWithinPlugin(normalized, root);
};
