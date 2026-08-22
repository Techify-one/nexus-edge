import { base64url, fromBase64url, sha256 } from "@app/webhook-contract";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const randomToken = (bytes = 32): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
};

export const hashToken = (value: string): Promise<string> => sha256(value);

export async function timingSafeEqual(
  left: string,
  right: string,
): Promise<boolean> {
  const leftHash = fromBase64url(await sha256(left));
  const rightHash = fromBase64url(await sha256(right));
  if (leftHash.length !== rightHash.length) return false;
  let difference = 0;
  for (let index = 0; index < leftHash.length; index++)
    difference |= leftHash[index]! ^ rightHash[index]!;
  return difference === 0;
}

async function importAesKey(encodedKey: string): Promise<CryptoKey> {
  const raw = fromBase64url(encodedKey);
  if (raw.byteLength !== 32)
    throw new Error(
      "WEBHOOK_ENCRYPTION_KEY must be 32 bytes in base64url format",
    );
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(
  value: string,
  encodedKey: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      await importAesKey(encodedKey),
      encoder.encode(value),
    ),
  );
  return `v1.${base64url(iv)}.${base64url(ciphertext)}`;
}

export async function decryptSecret(
  value: string,
  encodedKey: string,
): Promise<string> {
  const [version, iv, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext)
    throw new Error("Unsupported encrypted value");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv) as BufferSource },
    await importAesKey(encodedKey),
    fromBase64url(ciphertext) as BufferSource,
  );
  return decoder.decode(plaintext);
}
