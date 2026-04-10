/**
 * Stateless OAuth helpers for single-user MCP auth.
 *
 * Auth codes are signed tokens (HMAC-SHA256) containing the client_id,
 * redirect_uri, code_challenge, and expiry. No server-side storage needed.
 */

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function hmacSign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return base64url(new Uint8Array(sig));
}

async function hmacVerify(data: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(data, secret);
  return expected === signature;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(padded);
}

export async function createAuthCode(
  clientId: string,
  redirectUri: string,
  codeChallenge: string,
  secret: string
): Promise<string> {
  const expiry = Date.now() + AUTH_CODE_TTL_MS;
  const payload = `${clientId}|${redirectUri}|${codeChallenge}|${expiry}`;
  const payloadB64 = base64url(new TextEncoder().encode(payload));
  const sig = await hmacSign(payload, secret);
  return `${payloadB64}.${sig}`;
}

interface AuthCodePayload {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiry: number;
}

export async function verifyAuthCode(
  code: string,
  secret: string
): Promise<AuthCodePayload | null> {
  const parts = code.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  let payload: string;
  try {
    payload = base64urlDecode(payloadB64);
  } catch {
    return null;
  }

  const valid = await hmacVerify(payload, sig, secret);
  if (!valid) return null;

  const segments = payload.split("|");
  if (segments.length !== 4) return null;

  const [clientId, redirectUri, codeChallenge, expiryStr] = segments;
  const expiry = parseInt(expiryStr, 10);

  if (Date.now() > expiry) return null;

  return { clientId, redirectUri, codeChallenge, expiry };
}

export async function verifyPKCE(
  codeVerifier: string,
  codeChallenge: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(codeVerifier));
  const computed = base64url(new Uint8Array(digest));
  return computed === codeChallenge;
}
