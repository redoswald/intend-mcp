import { createAuthCode } from "@/lib/oauth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client_id") || "";
  const redirectUri = url.searchParams.get("redirect_uri") || "";
  const state = url.searchParams.get("state") || "";
  const codeChallenge = url.searchParams.get("code_challenge") || "";
  const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";

  if (!clientId || !redirectUri || !codeChallenge) {
    return new Response("Missing required parameters", { status: 400 });
  }

  if (codeChallengeMethod && codeChallengeMethod !== "S256") {
    return new Response("Only S256 code challenge method is supported", { status: 400 });
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intend — Authorize</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8f8f8;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: white;
      border-radius: 12px;
      padding: 2.5rem;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 2px 12px rgba(0,0,0,0.08);
      text-align: center;
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; color: #1a1a1a; }
    p { color: #666; margin-bottom: 1.5rem; line-height: 1.5; }
    .scope {
      background: #f0f4ff;
      border-radius: 8px;
      padding: 1rem;
      margin-bottom: 1.5rem;
      text-align: left;
      color: #333;
      font-size: 0.9rem;
    }
    .scope strong { color: #4F46E5; }
    button {
      background: #4F46E5;
      color: white;
      border: none;
      padding: 0.75rem 2rem;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      width: 100%;
      font-weight: 500;
    }
    button:hover { background: #4338CA; }
    .deny {
      background: none;
      color: #999;
      margin-top: 0.75rem;
      font-size: 0.85rem;
    }
    .deny:hover { color: #666; background: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Intend</h1>
    <p>An application wants to access your task manager.</p>
    <div class="scope">
      <strong>This will allow it to:</strong><br>
      Read and write your tasks, projects, and sections
    </div>
    <form method="POST">
      <input type="hidden" name="client_id" value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <button type="submit">Approve</button>
    </form>
    <form method="POST">
      <input type="hidden" name="deny" value="1">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <button type="submit" class="deny">Deny</button>
    </form>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

export async function POST(req: Request) {
  const body = await req.formData();
  const redirectUri = body.get("redirect_uri") as string;
  const state = body.get("state") as string;

  if (body.get("deny")) {
    const denyUrl = new URL(redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    if (state) denyUrl.searchParams.set("state", state);
    return Response.redirect(denyUrl.toString(), 302);
  }

  const clientId = body.get("client_id") as string;
  const codeChallenge = body.get("code_challenge") as string;

  const secret = process.env.MCP_BEARER_TOKEN;
  if (!secret) {
    return new Response("Server misconfigured", { status: 500 });
  }

  const code = await createAuthCode(clientId, redirectUri, codeChallenge, secret);

  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);
  if (state) callbackUrl.searchParams.set("state", state);

  return Response.redirect(callbackUrl.toString(), 302);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
