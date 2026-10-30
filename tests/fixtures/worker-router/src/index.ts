// The Cloudflare Worker: sign-in pages, the OAuth endpoints and the MCP address, in one fetch handler.
import { mcp } from "./mcp";
import registry from "./tools.json";

export default {
  async fetch(req: Request, env: unknown): Promise<Response> {
    const url = new URL(req.url), path = url.pathname, method = req.method;
    const known = path === "/mcp" || path === "/token" || path.startsWith("/signin") || path.startsWith("/.well-known/oauth-");
    if (!known) return new Response("Not found", { status: 404 });
    if (method === "GET" && path.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: url.origin + "/mcp" });
    if (path === "/mcp") return method === "POST" ? mcp(req, registry) : new Response(null, { status: 405 });
    if (path === "/token" && method === "POST") return new Response("token");
    if (path === "/signin" && method === "GET") return new Response("<form>");
    if (path === "/signin" && method === "POST") return new Response("ok");
    return new Response("Not found", { status: 404 });
  },
};

/** Static pages, switched on the address. */
export function pages(url: URL): Response {
  switch (url.pathname) {
    case "/privacy": return new Response("privacy");
    case "/terms": return new Response("terms");
    default: return new Response("Not found", { status: 404 });
  }
}
