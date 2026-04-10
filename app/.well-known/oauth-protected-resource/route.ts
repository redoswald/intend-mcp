import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";
import { getPublicOrigin } from "mcp-handler";

export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  const handler = protectedResourceHandler({
    authServerUrls: [origin],
  });
  return handler(req);
}

const corsHandler = metadataCorsOptionsRequestHandler();

export function OPTIONS() {
  return corsHandler();
}
