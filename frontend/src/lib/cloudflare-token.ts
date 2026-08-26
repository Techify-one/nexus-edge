export function cloudflareAccountTokensUrl(accountId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(accountId))
    throw new Error("Invalid Cloudflare account identifier");
  return new URL(
    `/${encodeURIComponent(accountId)}/api-tokens`,
    "https://dash.cloudflare.com",
  ).toString();
}

export function cloudflarePluginTokenTemplateUrl(accountId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(accountId))
    throw new Error("Invalid Cloudflare account identifier");
  const url = new URL("https://dash.cloudflare.com/");
  url.searchParams.set("to", `/${accountId}/api-tokens`);
  url.searchParams.set(
    "permissionGroupKeys",
    JSON.stringify([{ key: "workers_scripts", type: "edit" }]),
  );
  url.searchParams.set("name", "Nexus Edge Plugins");
  return url.toString();
}
