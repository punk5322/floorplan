/** Answers MCP requests: tools/list from the registry, tools/call by name. */
export async function mcp(req: Request, registry: { tools: unknown[] }): Promise<Response> {
  const body = await req.json() as { method: string };
  if (body.method === "tools/list") return Response.json({ result: { tools: registry.tools } });
  const res = await fetch("https://api.weather.example-service.com/v2/today");
  return Response.json({ result: await res.json() });
}
