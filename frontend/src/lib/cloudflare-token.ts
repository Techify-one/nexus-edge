export function cloudflareAccountTokensUrl(accountId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(accountId))
    throw new Error("Invalid Cloudflare account identifier");
  return new URL(
    `/${encodeURIComponent(accountId)}/api-tokens`,
    "https://dash.cloudflare.com",
  ).toString();
}

export function cloudflareUserTokensUrl(): string {
  return "https://dash.cloudflare.com/profile/api-tokens";
}

export function cloudflareR2TokenTemplateUrl(accountId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(accountId))
    throw new Error("Invalid Cloudflare account identifier");
  const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
  url.searchParams.set(
    "permissionGroupKeys",
    JSON.stringify([{ key: "workers_r2", type: "edit" }]),
  );
  url.searchParams.set("accountId", accountId);
  url.searchParams.set("zoneId", "all");
  url.searchParams.set("name", "Nexus Edge Plugin R2");
  return url.toString();
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
