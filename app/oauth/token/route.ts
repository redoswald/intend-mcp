import { verifyAuthCode, verifyPKCE } from "@/lib/oauth";

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") || "";

  let grantType: string | null = null;
  let code: string | null = null;
  let codeVerifier: string | null = null;
  let redirectUri: string | null = null;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const body = await req.formData();
    grantType = body.get("grant_type") as string;
    code = body.get("code") as string;
    codeVerifier = body.get("code_verifier") as string;
    redirectUri = body.get("redirect_uri") as string;
  } else {
    const body = await req.json();
    grantType = body.grant_type;
    code = body.code;
    codeVerifier = body.code_verifier;
    redirectUri = body.redirect_uri;
  }

  if (grantType !== "authorization_code") {
    return errorResponse("unsupported_grant_type", "Only authorization_code is supported");
  }

  if (!code || !codeVerifier) {
    return errorResponse("invalid_request", "Missing code or code_verifier");
  }

  const secret = process.env.MCP_BEARER_TOKEN;
  if (!secret) {
    return errorResponse("server_error", "Server misconfigured");
  }

  const payload = await verifyAuthCode(code, secret);
  if (!payload) {
    return errorResponse("invalid_grant", "Invalid or expired authorization code");
  }

  if (redirectUri && redirectUri !== payload.redirectUri) {
    return errorResponse("invalid_grant", "redirect_uri mismatch");
  }

  const pkceValid = await verifyPKCE(codeVerifier, payload.codeChallenge);
  if (!pkceValid) {
    return errorResponse("invalid_grant", "PKCE verification failed");
  }

  // Issue the access token (our static bearer token)
  const response = {
    access_token: secret,
    token_type: "Bearer",
    expires_in: 3600 * 24 * 365, // 1 year — effectively non-expiring
    scope: "mcp:tools",
  };

  return new Response(JSON.stringify(response), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

function errorResponse(error: string, description: string) {
  return new Response(
    JSON.stringify({ error, error_description: description }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}
