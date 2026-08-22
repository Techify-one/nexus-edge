import { AppError } from "../lib/http.js";

const blockedHostname =
  /(^localhost$|\.localhost$|\.local$|\.internal$|\.home$)/iu;
const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

const privateIpv4 = (host: string): boolean => {
  const match = host.match(ipv4);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

export function validateWebhookUrl(value: string, allowlistRaw?: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(
      422,
      "WEBHOOK_URL_INVALID",
      "The webhook URL is invalid.",
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443"))
    throw new AppError(422, "WEBHOOK_HTTPS_REQUIRED", "Use HTTPS on port 443.");
  if (url.username || url.password || url.search || url.hash)
    throw new AppError(
      422,
      "WEBHOOK_URL_COMPONENT_FORBIDDEN",
      "The URL cannot contain credentials, a query string, or a fragment.",
    );
  if (
    blockedHostname.test(hostname) ||
    privateIpv4(hostname) ||
    hostname.includes(":") ||
    !hostname.includes(".")
  ) {
    throw new AppError(
      422,
      "WEBHOOK_DESTINATION_FORBIDDEN",
      "The webhook destination is not allowed.",
    );
  }
  const allowlist = (allowlistRaw ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    allowlist.length &&
    !allowlist.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    )
  ) {
    throw new AppError(
      422,
      "WEBHOOK_DESTINATION_NOT_ALLOWLISTED",
      "The domain is not in this installation's allowlist.",
    );
  }
  return url;
}
