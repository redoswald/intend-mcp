import { createId } from "@paralleldrive/cuid2";

export async function POST(req: Request) {
  const body = await req.json();

  const clientId = createId();
  const now = Math.floor(Date.now() / 1000);

  const response = {
    client_id: clientId,
    client_id_issued_at: now,
    ...body,
  };

  return new Response(JSON.stringify(response), {
    status: 201,
    headers: {
      "Content-Type": "application/json",
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
