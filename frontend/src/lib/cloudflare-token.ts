export function cloudflareAccountTokensUrl(accountId: string): string {
  if (!/^[a-f0-9]{32}$/u.test(accountId))
    throw new Error("Invalid Cloudflare account identifier");
  return new URL(
    `/${encodeURIComponent(accountId)}/api-tokens`,
    "https://dash.cloudflare.com",
  ).toString();
}
