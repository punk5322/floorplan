// Endpoints beyond web frameworks: Swift servers (Vapor, a hand-written NWListener router), hand-written
// JS routers (a Cloudflare Worker), Python's http.server, and MCP tools (TypeScript SDK, a Swift
// registry, a JSON tool list), each shown as an endpoint of kind "MCP tool" under its server's /mcp.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readGraph, routeKeys, openEndpoints, shopApp, cleanup } from './helpers.mjs';

const { extract, mcpTools, jsonTools } = await lib('extract.mjs');

const roots = [];
after(() => roots.forEach(cleanup));
/** Copies a fixture to a temp folder (fixture folders' own routes are skipped as test code), maps it, returns the graph. */
function mapFixture(name) {
  const root = makeProject({}, { arch: { project: { name, summary: 'Test fixture.' }, nodes: [{ id: 'app', label: 'Server', kind: 'service', summary: 'The server.', paths: ['**'] }] } });
  roots.push(root);
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', name), root, { recursive: true });
  const summary = run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  return { graph: readGraph(root), summary, root };
}
const tools = (g) => g.routes.filter((r) => r.m === 'TOOL').map((r) => `${r.p} ${r.f}`).sort();

test('Vapor: app.get with path pieces, grouped and group prefixes, and a RouteCollection', () => {
  const { graph } = mapFixture('vapor-app');
  assert.deepEqual(routeKeys(graph), ['DELETE /api/v1/admin/users/:id', 'GET /', 'GET /hello/:name', 'GET /todos', 'PATCH /todos/:todoID', 'POST /api/v1/login', 'POST /todos']);
  assert.equal(graph.routes.find((r) => r.m === 'POST' && r.p === '/todos').h, 'create');
});

test('a hand-written NWListener router: (method, path) cases, hasPrefix, switch on path, path ==', () => {
  const { graph } = mapFixture('swift-server');
  const web = routeKeys(graph).filter((k) => !k.startsWith('TOOL'));
  assert.deepEqual(web, ['ANY /health', 'ANY /ping', 'GET /', 'GET /.well-known/oauth-protected-resource', 'GET /guide.md', 'POST /mcp', 'POST /token', 'POST /token/refresh']);
});

test('a Swift MCP registry: each t("snake_name", …) entry is a tool, with its description; other arrays are not', () => {
  const { graph, summary } = mapFixture('swift-server');
  const file = 'Sources/Server/AgentTools.swift';
  assert.deepEqual(tools(graph), [`/mcp/create_items ${file}`, `/mcp/get_context ${file}`, `/mcp/search ${file}`]);
  assert.equal(graph.routes.find((r) => r.p === '/mcp/get_context').d, "The one orientation call: who you are and what's on today.");
  assert.match(summary, /MCP TOOLS {2}3/);
  assert.match(summary, /ENDPOINTS {2}8 web routes · 3 MCP tools/);
});

test('a Cloudflare Worker: pathname checks with methods, startsWith, switch on pathname; a "known paths" line adds nothing', () => {
  const { graph } = mapFixture('worker-router');
  const web = routeKeys(graph).filter((k) => !k.startsWith('TOOL'));
  assert.deepEqual(web, ['ANY /privacy', 'ANY /terms', 'GET /.well-known/oauth-protected-resource', 'GET /signin', 'POST /mcp', 'POST /signin', 'POST /token']);
});

test('a JSON tool list belongs to the server that imports it, and its calls out are outbound', () => {
  const { graph } = mapFixture('worker-router');
  assert.deepEqual(tools(graph), ['/mcp/get_weather src/index.ts', '/mcp/list_plans src/index.ts']);
  assert.equal(graph.routes.find((r) => r.p === '/mcp/list_plans').d, 'Your plans for the week, soonest first.');
  assert.deepEqual(graph.outbound, [{ host: 'api.weather.example-service.com', files: ['src/mcp.ts'], node: null }]);
});

test('the TypeScript SDK: server.tool and registerTool, but not some other .tool()', () => {
  const { graph } = mapFixture('mcp-ts');
  assert.deepEqual(tools(graph), ['/mcp/add_note src/server.ts', '/mcp/list_notes src/server.ts']);
  assert.equal(graph.routes.find((r) => r.p === '/mcp/add_note').d, 'Saves a new note with the given text.');
});

test('Health stays quiet about hand-written routes and MCP tools (their checks live where the request is handed off)', () => {
  for (const name of ['worker-router', 'mcp-ts']) assert.deepEqual(openEndpoints(mapFixture(name).graph), []);
});

test('MCP tools are never matched to web calls', () => {
  const { matchCalls } = { matchCalls: null };
  return lib('routes.mjs').then(({ matchCalls: m }) => {
    const routes = [{ file: 'srv/tools.ts', method: 'TOOL', path: '/mcp/search' }];
    assert.deepEqual(m([{ path: 'web/a.ts', calls: [{ path: '/mcp/search', method: null, line: 1 }] }], routes), []);
  });
});

test('Python: http.server do_GET path checks and @mcp.tool functions', () => {
  const r = extract([
    'from http.server import BaseHTTPRequestHandler',
    'class Handler(BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        if self.path == "/health":',
    '            return self.ok()',
    '        if self.path.startswith("/files/"):',
    '            return self.file()',
    '    def do_POST(self):',
    '        if self.path == "/upload":',
    '            return self.save()',
    '',
    '@mcp.tool()',
    'def get_forecast(city: str) -> str:',
    '    """Tomorrow\'s forecast for a city, in plain words."""',
  ].join('\n'), 'python', 'server.py');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /health', 'GET /files/', 'POST /upload', 'TOOL /mcp/get_forecast']);
  assert.equal(r.routes.at(-1).doc, "Tomorrow's forecast for a city, in plain words.");
});

test('the registry detector needs a tools-named array and one helper making every entry', () => {
  const at = () => 1;
  const swift = (src) => { const r = extract(src, 'swift', 'X.swift'); return r.routes.filter((x) => x.method === 'TOOL').map((x) => x.path); };
  assert.deepEqual(swift('let words = [f("one_two"), f("three")]'), [], 'not named like tools');
  assert.deepEqual(swift('let tools = [f("one_two")]'), [], 'a single entry is not a registry');
  assert.deepEqual(swift('static let tools: [Tool] = [f("Not A Name", "x"), f("also not")]'), [], 'names are snake_case');
  assert.deepEqual(swift('let all: [AgentTool] = [\n  t("a_b", "Does a."),\n  t("c", "Does c."),\n]'), ['/mcp/a_b', '/mcp/c']);
  assert.deepEqual(mcpTools('const tools = [{ name: "x_y", description: "Does x.", inputSchema: {} }, { name: "z", inputSchema: {} }];', 'const tools = [{ name: "   ", description: "        ", inputSchema: {} }, { name: " ", inputSchema: {} }];', at, 'js').map((t) => t.path), ['/mcp/x_y', '/mcp/z']);
  assert.deepEqual(jsonTools([{ name: 'a', inputSchema: {} }, { name: 'b' }]).map((t) => t.path), ['/mcp/a'], 'a JSON entry needs an input schema');
});

test('no false endpoints or tools in the existing fixtures', () => {
  for (const name of ['firebase-app', 'fastapi-annotated']) {
    const { graph } = mapFixture(name);
    assert.ok(!graph.routes.some((r) => r.m === 'TOOL'), `${name}: no MCP tools`);
  }
  const root = shopApp();
  roots.push(root);
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  assert.deepEqual(routeKeys(readGraph(root)), ['DELETE /admin/users/:id', 'GET /api/orders', 'POST /api/notes', 'POST /api/orders/:id/refund']);
});
