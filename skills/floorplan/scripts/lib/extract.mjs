// Per-language, regex-based extraction of imports, exported symbols, HTTP routes and HTTP calls.
// Deliberately approximate: good enough to draw the map, cheap enough to run on any repo.
import { swiftStrip, swiftFacts, closeOf, IMPORT_RE } from './swift.mjs';

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

const blank = (s) => s.replace(/[^\n]/g, ' ');
// Strip comments while keeping offsets (so line numbers stay right).
const stripCStyle = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));
const stripHash = (src) => src.replace(/(^|\s)#[^\n]*/g, (m, pre) => pre + blank(m.slice(pre.length)));

const all = (re, s) => [...s.matchAll(re)];

// ---------- HTTP call literals ----------

const HTTP_CONTEXT = /\b(fetch|axios|ky|got|request|requests|httpx|aiohttp|session|client|http|https|api|Api|API|endpoint|Endpoint|url|Url|URL|BASE|base)\b|\.(get|post|put|patch|delete|head)\s*(<[^>]*>)?\s*\(|(?<![.\w$])(get|post|put|patch|delete)\s*\(\s*[rf]?["'`]\//;
const NAV_CONTEXT = /\b(router\.(push|replace|prefetch)|navigate|redirect|href|revalidatePath|pathname|Link|to=|location\.)\b|window\.location/;
const STR_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const IGNORED_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$|\.(test|example|invalid|local|localhost|internal)(:\d+)?$|(^|\.)example\.(com|org|net)$/;
const FILE_EXT_TAIL = /\.(png|jpe?g|gif|svg|ico|webp|css|js|mjs|ts|tsx|json|html?|txt|md|pdf|csv|xml|woff2?|ttf|map)$/i;

function normalizeCallLiteral(raw) {
  // Swift interpolation reads like a template's: "\(base)/items/\(id)" → ${x}/items/${x}
  let s = raw.trim().replace(/\\\([^)]*\)/g, '${x}');
  let host = null;
  // a Firebase function's own address (https://us-central1-<project>.cloudfunctions.net/signDocument) is
  // this app's backend, not an outside service
  const fn = /^https?:\/\/[^/\s]*\.cloudfunctions\.net(\/.*)$/i.exec(s);
  if (fn) s = fn[1];
  const abs = /^https?:\/\/([^/${}\s]+)(.*)$/i.exec(s);
  if (abs) { host = abs[1].toLowerCase().replace(/:$/, ''); s = abs[2] || '/'; } // "127.0.0.1:\(port)": the port is interpolated
  // leading interpolations: ${API_BASE}/x, {BASE_URL}/x
  s = s.replace(/^(?:\$\{[^}]*\}|\{[^}]*\})+/, '');
  if (!s.startsWith('/')) return null;
  s = s.split(/[?#]/)[0];
  // a query string interpolated straight onto the last segment: `/cost-lots${qs}`, `/items{query}`
  s = s.replace(/([A-Za-z0-9_\-])(?:\$\{[^}]*\}|\{[^}]*\})+$/, '$1');
  if (!/^\/[\w\-.~%/*${}:@<>\[\]]*$/.test(s)) return null;
  if (FILE_EXT_TAIL.test(s)) return null;
  if (!/[a-zA-Z]{2,}/.test(s.replace(/\$\{[^}]*\}|\{[^}]*\}/g, ''))) return host ? { host, path: null } : null;
  return { host, path: s };
}

/**
 * Collapse every ${…} inside template literals to ${x}, counting braces, so nested templates like
 * `/orders${q ? `?${q}` : ''}` read as one literal "/orders${x}" instead of breaking at the inner backtick.
 */
export function flattenTemplates(line) {
  let out = '', inTpl = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\') { out += c + (line[i + 1] ?? ''); i++; continue; }
    if (c === '`') { inTpl = !inTpl; out += c; continue; }
    if (inTpl && c === '$' && line[i + 1] === '{') {
      let depth = 1, j = i + 2;
      for (; j < line.length && depth; j++) { if (line[j] === '{') depth++; else if (line[j] === '}') depth--; }
      out += '${x}'; i = j - 1; continue;
    }
    out += c;
  }
  return out;
}

// `api.post(…)`, or a bare helper imported from an API client: `post("/orders", …)`
const METHOD_CALL = /(?:\.|(?<![\w$])(?=(?:get|post|put|patch|delete)\s*\(\s*[rf]?["'`]\/))(get|post|put|patch|delete)\s*(?:<[^>]*>)?\s*\(/i;
const METHOD_OPT = /method\s*[:=]\s*["'`](\w+)/i;
// `const url = …`, `url = f"…"`, `this.endpoint = …`: a URL kept in a variable for the call below
const ASSIGN = /(?:\b(?:const|let|var)\s+|^\s*(?:self\.|this\.)?)([A-Za-z_$][\w$]*)\s*(?::\s*[\w<>[\]|. ]+?\s*)?=(?![=>])/;
/** Where a variable is passed to an HTTP call within the next few lines, and with which method. */
function variableUse(lines, i, name) {
  const use = new RegExp(`(?:\\.(get|post|put|patch|delete|head|request)\\s*(?:<[^>]*>)?\\s*\\(|\\b(?:fetch|axios|ky|got|request|urlopen)\\s*\\(|\\brequests\\.(get|post|put|patch|delete)\\s*\\()\\s*${name}\\b`, 'i');
  for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
    const m = use.exec(lines[j]);
    if (!m) continue;
    const verb = (m[1] && m[1].toLowerCase() !== 'request' ? m[1] : m[2]) || METHOD_OPT.exec(lines.slice(j, j + 4).join(' '))?.[1] || '';
    return { method: verb.toUpperCase() || null };
  }
  return null;
}

function extractCalls(src, at, { skip } = {}) {
  const calls = [];
  const hosts = [];
  const lines = src.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = flattenTemplates(lines[i]);
    const lineStart = offset;
    offset += lines[i].length + 1;
    if (line.length > 500 || NAV_CONTEXT.test(line)) continue;
    if (skip && skip.test(line)) continue;
    // a URL assigned to a variable counts when an HTTP call below uses that variable
    const assigned = ASSIGN.exec(line)?.[1];
    const use = assigned ? variableUse(lines, i, assigned) : null;
    if (!HTTP_CONTEXT.test(line) && !use) continue;
    const method = (METHOD_CALL.exec(line)?.[1] || METHOD_OPT.exec(line)?.[1] || use?.method || '').toUpperCase() || null;
    for (const m of line.matchAll(STR_LITERAL)) {
      const n = normalizeCallLiteral(m[2]);
      if (!n) continue;
      const lineNo = at(lineStart);
      if (n.host && !IGNORED_HOST.test(n.host) &&!n.host.includes('${') && !n.host.includes('{')) hosts.push({ host: n.host, line: lineNo });
      if (n.path && !n.host) calls.push({ path: n.path, method, line: lineNo });
    }
  }
  return { calls, hosts };
}

// ---------- JS / TS ----------

/** Imported names plus their local bindings: `import users, { a as b } from` → locals { users: 'default', b: 'a' }. */
function parseImportClause(clause) {
  const names = [];
  const locals = {};
  const c = clause.replace(/^type\s+/, '').trim();
  const brace = /\{([^}]*)\}/.exec(c);
  if (brace) for (const part of brace[1].split(',')) {
    const [orig, alias] = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).map((s) => s?.trim());
    if (orig) { names.push(orig); locals[alias || orig] = orig; }
  }
  const head = c.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
  const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(head);
  if (ns) locals[ns[1]] = '*';
  const def = /^([A-Za-z_$][\w$]*)/.exec(head);
  if (def && def[1] !== 'as') { names.push('default'); locals[def[1]] = 'default'; }
  return { names, locals };
}

function extractJs(src, filePath) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/(?:^|[;\n}])\s*import\s+(?!\()((?:type\s+)?[^'";]*?)\s+from\s+["']([^"'\n]+)["']/g, code)) imports.push({ spec: m[2], ...parseImportClause(m[1]), line: at(m.index) });
  for (const m of all(/(?:^|[;\n])\s*import\s+["']([^"'\n]+)["']/g, code)) imports.push({ spec: m[1], names: [], line: at(m.index) });
  for (const m of all(/\bexport\s+(?:type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+["']([^"'\n]+)["']/g, code)) {
    // `export { a as b } from` → exported { b: 'a' }, the names this file passes on
    const clause = m[1].startsWith('{') ? parseImportClause(m[1]) : null;
    imports.push({ spec: m[2], names: clause ? clause.names : [], ...(clause ? { exported: clause.locals } : {}), line: at(m.index), reexport: true });
  }
  for (const m of all(/\brequire\(\s*["']([^"'\n]+)["']\s*\)/g, code)) {
    // `const usersRouter = require('./users')` / `const { a, b: c } = require(…)` bind local names
    const before = code.slice(code.lastIndexOf('\n', m.index) + 1, m.index);
    const bind = /(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
    const locals = {};
    if (bind?.[1].startsWith('{')) for (const part of bind[1].slice(1, -1).split(',')) { const [orig, alias] = part.trim().split(/\s*:\s*/); if (orig) locals[(alias || orig).trim()] = orig.trim(); }
    else if (bind) locals[bind[1]] = 'default';
    imports.push({ spec: m[1], names: Object.values(locals), locals, line: at(m.index) });
  }
  for (const m of all(/\bimport\(\s*["']([^"'\n]+)["']\s*\)/g, code)) imports.push({ spec: m[1], names: [], line: at(m.index), dynamic: true });

  const symbols = [];
  const seen = new Set();
  const addSym = (name, kind, idx, isDefault) => {
    const key = name + (isDefault ? '#d' : '');
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({ name, kind, line: at(idx), ...(isDefault ? { default: true } : {}) });
  };
  for (const m of all(/^[ \t]*export\s+(default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm, code)) {
    const kind = m[2].startsWith('function') ? 'function' : ['const', 'let', 'var'].includes(m[2]) ? 'const' : m[2];
    addSym(m[3], kind, m.index, !!m[1]);
  }
  for (const m of all(/^[ \t]*export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm, code)) {
    if (!['function', 'class', 'async'].includes(m[1])) addSym(m[1], 'default', m.index, true);
  }
  for (const m of all(/^[ \t]*export\s*\{([^}]*)\}\s*;?\s*$/gm, code)) {
    for (const part of m[1].split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig) addSym((alias || orig).trim(), 'export', m.index, (alias || '').trim() === 'default');
    }
  }
  // Next.js route handlers / module exports
  for (const m of all(/^[ \t]*module\.exports\s*=\s*([A-Za-z_$][\w$]*)?/gm, code)) addSym(m[1] || 'module.exports', 'default', m.index, true);

  // Express / Koa / Hono style routes and mounts
  const routes = [];
  const mounts = [];
  for (const m of all(/\b([A-Za-z_$][\w$]*)\.(get|post|put|patch|delete|all|options|head)\(\s*["'`](\/[^"'`]*)["'`]/g, code)) {
    if (!/^(app|server|fastify|hono|routes?|[a-z]*Router|router)$/.test(m[1])) continue;
    routes.push({ method: m[2].toUpperCase(), path: m[3], var: m[1], line: at(m.index) });
  }
  for (const m of all(/\b([A-Za-z_$][\w$]*)\.(use|route)\(\s*["'`](\/[^"'`]*)["'`]\s*,([^\n;]*)/g, code)) {
    const req = /require\(\s*["']([^"']+)["']\s*\)/.exec(m[4]);
    const mw = (m[4].split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][w$.]*$/.test(s))).map((s) => s.split('.').pop());
    if (req) { mounts.push({ prefix: m[3], spec: req[1], line: at(m.index), ...(mw.length ? { mw } : {}) }); continue; }
    const args = m[4].replace(/\)\s*$/, '').split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$.]*$/.test(s));
    if (args.length) mounts.push({ prefix: m[3], var: args[args.length - 1], line: at(m.index), ...(args.length > 1 ? { mw: args.slice(0, -1).map((s) => s.split('.').pop()) } : {}) });
  }

  // Next.js app/pages API routes, derived from the file path
  const next = /(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.(?:t|j)sx?$/.exec(filePath) || /(?:^|\/)(?:src\/)?pages\/(api\/.*?)(?:\/index)?\.(?:t|j)sx?$/.exec(filePath);
  if (next) {
    const p = '/' + next[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@')).join('/');
    const methods = all(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g, code).map((m) => m[1]);
    for (const method of methods.length ? methods : ['ANY']) routes.push({ method, path: p, var: null, line: 1, framework: 'next' });
  }

  const triggers = /firebase-functions/.test(code) ? firebaseFunctions(code, at, routes, mounts) : [];
  const hand = /\bpathname\b/.test(code) ? jsHandRoutes(code, at) : null;
  if (hand) routes.push(...hand.routes);
  routes.push(...mcpTools(code, blankStrings(code), at, 'js'));

  const serverLine = /\b\w+\.(use|route)\(\s*["'`]\/|\b(?:app|server|fastify|hono|routes?|router|[a-z]+Router)\.(?:get|post|put|patch|delete|all|options|head)\(\s*["'`]\//;
  const { calls, hosts } = extractCalls(code, at, { skip: hand ? new RegExp(`${serverLine.source}|${hand.skip.source}`) : serverLine });
  const seenCall = new Set(calls.map((c) => `${c.line}|${c.path}`));
  for (const c of wrapperCalls(code, at)) if (!seenCall.has(`${c.line}|${c.path}`)) calls.push(c);
  const callables = /\bhttpsCallable\b/.test(code) ? callableCalls(code, at) : { calls: [], wrappers: [] };
  calls.push(...callables.calls);
  return { imports, symbols, routes, mounts, calls, hosts, ...(triggers.length ? { triggers } : {}), ...(callables.wrappers.length ? { callableWrappers: callables.wrappers } : {}) };
}

// ---------- Firebase Cloud Functions ----------

// `export const approveItem = onCall(…)`, `exports.sign = functions.region('eu').https.onRequest(…)`,
// `export const nightly = onSchedule('every day 03:00', …)`: the exported name, the chain before the
// trigger (v1 style `functions.firestore.document('x')`), and the trigger itself
const FIREBASE_FN = /(?:\bexport\s+(?:const|let|var)\s+|(?:^|[;\n])[ \t]*(?:const|let|var)\s+|\b(?:module\.)?exports\.)([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*((?:[A-Za-z_$][\w$]*(?:\([^()]*\))?\s*\.\s*)*)((?:on|before)[A-Z]\w*)\s*(?:<[^;]{0,300}?>)?\s*\(/g;
const FIRST_STRING = /["'`]([^"'`\n]{1,120})["'`]/;

/**
 * Callable and onRequest functions become endpoints named after their export (CALL /approveItem,
 * ANY /signDocument); Firebase serves an Express app passed to onRequest under the function's name,
 * so that becomes a mount. Every other trigger (schedules, Firestore, Storage, Pub/Sub, Auth) is a
 * background job, returned for the scan summary.
 */
function firebaseFunctions(code, at, routes, mounts) {
  const triggers = [];
  for (const m of code.matchAll(FIREBASE_FN)) {
    const [, name, chain, on] = m;
    const line = at(m.index + m[0].indexOf(name));
    const args = code.slice(m.index + m[0].length, m.index + m[0].length + 300);
    if (on === 'onCall' || on === 'onCallGenkit' || on === 'onRequest') {
      routes.push({ method: on === 'onRequest' ? 'ANY' : 'CALL', path: '/' + name, var: null, line, framework: 'firebase', handler: name });
      const app = on === 'onRequest' && /^\s*(?:\{[^{}]*\}\s*,\s*)?([A-Za-z_$][\w$]*)\s*\)/.exec(args)?.[1];
      if (app) mounts.push({ prefix: '/' + name, var: app, line });
      continue;
    }
    // v1 triggers name the provider in the chain (functions.pubsub.schedule(…).onRun); v2 ones are named for it
    const provider = /\b(pubsub|firestore|storage|auth|database|tasks|analytics|remoteConfig|testLab)\b/.exec(chain)?.[1];
    if (chain ? !provider : !/^(onSchedule|onDocument|onObject|onMessagePublished|onValue|onTaskDispatched|onCustomEventPublished|on\w*Alert|onTestMatrix|onConfigUpdated|before[A-Z])/.test(on)) continue;
    // what it runs on: the last string in the chain (after any region), else the first argument
    const what = [...chain.matchAll(new RegExp(FIRST_STRING, 'g'))].pop()?.[1] || FIRST_STRING.exec(/^[^)]*/.exec(args)[0])?.[1] || null;
    triggers.push({ name, on: provider ? `${provider}.${on}` : on, ...(what ? { what } : {}), line });
  }
  return triggers;
}

// httpsCallable(functions, 'approveItem'), httpsCallable<Req, Res>(getFunctions(app), 'x') and the
// older functions.httpsCallable('x'); the generic arguments may span lines
const CALLABLE = /\bhttpsCallable\s*(?:<[^;]{0,300}?>)?\s*\(\s*(?:[^,()'"`]*(?:\([^()]*\))?\s*,\s*)?(["'`])([\w-]+)\1/g;
const DEFS = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:<[^>]*>\s*)?\(([^)]*)\)\s*(?::\s*[^=]+?)?=>/g;
/** A callable's name as a path: grouped functions deploy as `group-name`, so 'items-approve' → /items/approve. */
const callablePath = (name) => '/' + name.split('-').filter(Boolean).join('/');

/**
 * Calls to Firebase callable functions, by name, plus helpers that wrap httpsCallable
 * (`const call = (name, data) => httpsCallable(functions, name)(data)`) and their same-file uses.
 * The helpers' names are returned too, so scan.mjs can follow uses in the files that import them.
 */
function callableCalls(code, at) {
  const calls = [...code.matchAll(CALLABLE)].map((m) => ({ path: callablePath(m[2]), method: 'CALL', line: at(m.index) }));
  const wrappers = [];
  for (const m of code.matchAll(DEFS)) {
    const name = m[1] || m[3];
    const p0 = /^[A-Za-z_$][\w$]*/.exec((m[2] ?? m[4]).trim())?.[0];
    if (!p0) continue;
    const body = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
    if (!new RegExp(`\\bhttpsCallable\\s*(?:<[^;]{0,300}?>)?\\s*\\(\\s*(?:[^,()'"\`]*(?:\\([^()]*\\))?\\s*,\\s*)?${p0}\\s*[,)]`).test(body)) continue;
    wrappers.push(name);
    calls.push(...callsVia(code, name, at(m.index)));
  }
  return { calls, wrappers };
}

/** Uses of a callable helper: `callFunction('approveItem', data)` → CALL /approveItem. */
function callsVia(code, name, skipLine = 0) {
  const out = [];
  const re = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\s*(?:<[^;]{0,300}?>)?\\s*\\(\\s*(["'\`])([\\w-]+)\\1`, 'g');
  const at = lineIndex(code);
  for (const m of code.matchAll(re)) {
    const line = at(m.index);
    if (line !== skipLine) out.push({ path: callablePath(m[2]), method: 'CALL', line });
  }
  return out;
}
/** The same, in another file that imports the helper (under its local name there). */
export const callableCallsVia = (src, localName) => callsVia(stripCStyle(src), localName);

/**
 * Calls through a helper defined in the same file that adds a prefix and fetches, e.g.
 *   const call = (path, method = 'GET') => apiClient.request(`/inventory${path}`, { method });
 *   definitions: () => call('/definitions'),
 * becomes GET /inventory/definitions. Only same-file helpers whose first parameter is
 * spliced into a URL that an HTTP call fetches.
 */
function wrapperCalls(code, at) {
  const out = [];
  for (const m of code.matchAll(DEFS)) {
    const name = m[1] || m[3];
    const params = (m[2] ?? m[4]).split(',').map((p) => p.trim()).filter(Boolean);
    const pnames = params.map((p) => /^[A-Za-z_$][\w$]*/.exec(p)?.[0]);
    if (!pnames[0] || /^(get|post|put|patch|delete|request|fetch)$/i.test(name)) continue;
    const rawBody = code.slice(m.index + m[0].length, m.index + m[0].length + 700);
    const body = flattenTemplates(rawBody);
    if (!HTTP_CONTEXT.test(body)) continue;
    const tpl = spliced(rawBody, pnames[0]);
    if (tpl == null) continue;
    const methodIdx = pnames.findIndex((p, i) => i > 0 && (/^method$/i.test(p) || new RegExp(`method\\s*:\\s*${p}\\b`).test(body)));
    const defMethod = (methodIdx > 0 && /=\s*["'`](\w+)["'`]/.exec(params[methodIdx])?.[1]) || METHOD_CALL.exec(body)?.[1] || 'GET';
    const callRe = new RegExp(`\\b${name}\\s*(?:<[^>]*>)?\\(\\s*([\"'\`])((?:\\\\.|(?!\\1)[^\\\\\\n])*)\\1([^\\n]*)`, 'g');
    const defLine = at(m.index);
    code.split('\n').forEach((raw, i) => {
      if (i + 1 === defLine) return; // the definition itself
      for (const c of flattenTemplates(raw).matchAll(callRe)) {
        const n = normalizeCallLiteral(tpl + c[2]);
        if (!n?.path || n.host) continue;
        const verb = methodIdx > 0 ? /["'`](GET|POST|PUT|PATCH|DELETE)["'`]/i.exec(c[3])?.[1] : null;
        out.push({ path: n.path, method: (verb || defMethod).toUpperCase(), line: i + 1 });
      }
    });
  }
  return out;
}
/** The literal prefix right before ${param} in the helper's URL template (`${BASE}/prefix${path}` → "/prefix"), or null. */
function spliced(rawBody, param) {
  const raw = new RegExp(`\`((?:\\$\\{[^}]*\\})*)([^\`$]*)\\$\\{\\s*${param}\\s*\\}`).exec(rawBody);
  return raw ? raw[2] : null;
}

// ---------- hand-written routers and MCP tools (any language) ----------

const HTTP_VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/;
/**
 * Blank the contents of '…', "…" and `…` strings in C-style code (comments already stripped), so
 * brackets inside strings don't confuse bracket matching. Offsets don't move.
 */
function blankStrings(code) {
  return code.replace(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g, (m, q, body) => q + body.replace(/[^\n]/g, ' ') + q);
}
/** A route found by reading a hand-written router; `ANY` when no method is visible. */
const handRoute = (method, p, line) => ({ method, path: p, var: null, line, framework: 'handwritten' });
/**
 * Clean up a hand-written router's routes: one per method and path, and an `ANY /x` dropped when a
 * specific method is known for /x or a longer path starts with it (a "known paths" check above the router).
 */
function tidyHand(routes) {
  const seen = new Set();
  const out = routes.filter((r) => { const k = `${r.method} ${r.path}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return out.filter((r) => r.method !== 'ANY' || !out.some((o) => o !== r && (o.path === r.path ? o.method !== 'ANY' : r.path.length > 1 && o.path.startsWith(r.path))));
}

/**
 * MCP tools: an MCP server's tools are its real API, so each becomes an endpoint `TOOL /mcp/<name>`.
 * Recognised: the TypeScript SDK (`server.tool("name", "description", …)`, `registerTool("name",
 * { description })`), Python (`@mcp.tool()` above a def), and registries: an array named like tools
 * (`tools = [`, `let all: [AgentTool] = [`) whose entries are calls with a snake_case name first
 * (`t("get_context", "area", "Title", "description", …)`), or objects with name, description and inputSchema.
 * `text` has comments stripped and strings kept; `code` is the same with string contents blanked.
 */
export function mcpTools(text, code, at, lang) {
  const tools = [];
  const add = (name, desc, idx) => { if (!tools.some((t) => t.handler === name)) tools.push({ method: 'TOOL', path: '/mcp/' + name, var: null, line: at(idx), framework: 'mcp', handler: name, ...(desc ? { doc: cleanDoc(desc) || desc.slice(0, 220) } : {}) }); };
  if (lang === 'python') {
    for (const m of text.matchAll(/^[ \t]*@(\w+)\.tool\(([^)]*)\)\s*\n(?:[ \t]*@.*\n)*[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/gm)) {
      const named = /\bname\s*=\s*["']([\w.-]+)["']/.exec(m[2])?.[1];
      tools.push({ method: 'TOOL', path: '/mcp/' + (named || m[3]), var: null, line: at(m.index), framework: 'mcp', handler: m[3] });
    }
    return tools;
  }
  // SDK style: server.tool("name", "description", …) / server.registerTool("name", { description: "…" }, …)
  for (const m of text.matchAll(/\b(\w+)\.(tool|registerTool)\(\s*(["'`])([\w.-]+)\3\s*,\s*(?:(["'`])((?:\\.|(?!\5)[^\\])*?)\5|\{)?/g)) {
    if (m[2] === 'tool' && !/server|mcp/i.test(m[1])) continue;
    let desc = m[6];
    if (!desc && m[0].endsWith('{')) desc = /\bdescription\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*?)\1/.exec(text.slice(m.index, m.index + 1500))?.[2];
    add(m[4], desc, m.index);
  }
  // registries: an array named like tools (or of a *Tool type)
  for (const m of code.matchAll(/\b(?:let|var|const)\s+(\w+)\s*(?::\s*([^=\n]+?))?\s*=\s*\[/g)) {
    if (!/tool/i.test(m[1]) && !/tool/i.test(m[2] || '')) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    // the array's own elements: positions right after `[` or a comma at the array's top level
    const starts = [];
    let depth = 0;
    for (let i = open + 1; i < close; i++) {
      const c = code[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ',' && depth === 0) starts.push(i + 1);
    }
    starts.unshift(open + 1);
    const entries = [];
    for (let s of starts) {
      while (/\s/.test(code[s] || '')) s++;
      const call = /^(\w+)\s*\(/.exec(code.slice(s, s + 80));
      if (call) {
        const po = s + call[0].length - 1, pc = closeOf(code, po);
        const args = [];
        let d = 0, a0 = po + 1;
        for (let i = po + 1; i <= pc; i++) {
          const c = code[i];
          if (i === pc || (c === ',' && d === 0)) { args.push(text.slice(a0, i).trim()); a0 = i + 1; continue; }
          if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
        }
        const lit = (a) => /^(["'`])((?:\\.|(?!\1)[^\\])*)\1$/s.exec(a)?.[2];
        const name = lit(args[0] || '');
        if (name && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
          const desc = args.slice(1).map(lit).filter(Boolean).sort((x, y) => y.length - x.length)[0];
          entries.push({ fn: call[1], name, desc, idx: s });
        }
        continue;
      }
      if (code[s] === '{') {
        const obj = text.slice(s, closeOf(code, s) + 1);
        const name = /\bname["']?\s*:\s*(["'`])([\w.-]+)\1/.exec(obj)?.[2];
        if (name && /\b(inputSchema|input_schema)\b/.test(obj)) entries.push({ fn: '{}', name, desc: /\bdescription["']?\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*?)\1/.exec(obj)?.[2], idx: s });
      }
    }
    // one helper making every entry, at least twice: a registry, not a list that happens to start with a word
    const byFn = new Map();
    for (const e of entries) byFn.set(e.fn, (byFn.get(e.fn) || 0) + 1);
    const [fn, n] = [...byFn].sort((a, b) => b[1] - a[1])[0] || [];
    if (n >= 2) for (const e of entries) if (e.fn === fn) add(e.name, e.desc, e.idx);
  }
  return tools;
}

/** Tools listed in a JSON file (`{ "tools": [{ name, description, inputSchema }] }` or a bare array), or []. */
export function jsonTools(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.tools) ? json.tools : [];
  return list.filter((t) => t && typeof t.name === 'string' && (t.inputSchema || t.input_schema || t.parameters))
    .map((t) => ({ method: 'TOOL', path: '/mcp/' + t.name, var: null, line: 1, framework: 'mcp', handler: t.name, ...(typeof t.description === 'string' && t.description ? { doc: cleanDoc(t.description) || t.description.slice(0, 220) } : {}) }));
}

/**
 * Hand-written JS/TS routers, e.g. a Cloudflare Worker's `export default { fetch }`:
 * `url.pathname === "/x"`, `path === "/x" && method === "POST"`, `path.startsWith("/signin")` and
 * `switch (pathname) { case "/x": … }`, where `path` was read from a `.pathname`.
 */
function jsHandRoutes(code, at) {
  const vars = new Set(['pathname']);
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)*pathname\b/g)) vars.add(m[1]);
  const pv = `(?<![\\w$])(?:(?:[\\w$]+\\.)*pathname|(?<!\\.)(?:${[...vars].join('|')}))(?![\\w$])`;
  const cmp = new RegExp(`${pv}\\s*(?:===?\\s*|\\.startsWith\\(\\s*)(["'\`])(\\/[^"'\`]*)\\1`, 'g');
  const routes = [];
  let off = 0;
  for (const line of code.split('\n')) {
    const paths = [...line.matchAll(cmp)].map((m) => m[2]);
    if (paths.length) {
      const methods = [...line.matchAll(/\bmethod\s*===?\s*["'`]([A-Z]+)["'`]/g)].map((m) => m[1]).filter((x) => HTTP_VERB.test(x));
      for (const p of paths) for (const meth of methods.length ? methods : ['ANY']) routes.push(handRoute(meth, p, at(off)));
    }
    off += line.length + 1;
  }
  const blanked = blankStrings(code);
  for (const m of blanked.matchAll(new RegExp(`\\bswitch\\s*\\(\\s*${pv}\\s*\\)\\s*\\{`, 'g'))) {
    const open = m.index + m[0].length - 1;
    const body = code.slice(open, closeOf(blanked, open));
    for (const c of body.matchAll(/\bcase\s+(["'`])(\/[^"'`]*)\1\s*:/g)) routes.push(handRoute('ANY', c[2], at(open + c.index)));
  }
  return { routes: tidyHand(routes), skip: new RegExp(`${pv}\\s*(?:===?|\\.startsWith\\()`) };
}

/** Python's http.server: `if self.path == "/x"` inside `def do_GET(self)`. */
function pyHandRoutes(code, at) {
  const routes = [];
  const handlers = [...code.matchAll(/^[ \t]*def[ \t]+do_([A-Z]+)\s*\(\s*self/gm)].map((m) => ({ method: m[1], index: m.index }));
  if (!handlers.length) return [];
  for (const m of code.matchAll(/\b(?:self\.path|\w*path)\s*(?:==\s*|\.startswith\(\s*)[rb]?(["'])(\/[^"']*)\1/g)) {
    const h = handlers.filter((x) => x.index < m.index).pop();
    if (h) routes.push(handRoute(HTTP_VERB.test(h.method) ? h.method : 'ANY', m[2], at(m.index)));
  }
  return tidyHand(routes);
}

// ---------- Python ----------

function extractPy(src) {
  const code = stripHash(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^[ \t]*import[ \t]+([\w., \t]+)$/gm, code)) {
    for (const part of m[1].split(',')) {
      const [mod, alias] = part.trim().split(/\s+as\s+/);
      if (mod) imports.push({ spec: mod.trim(), names: [], alias: alias?.trim(), line: at(m.index) });
    }
  }
  for (const m of all(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gm, code)) {
    const names = [];
    const aliases = {};
    for (const part of m[2].replace(/[()\\]/g, ' ').split(',')) {
      const [orig, alias] = part.trim().split(/\s+as\s+/);
      if (orig && orig !== '*') { names.push(orig.trim()); if (alias) aliases[alias.trim()] = orig.trim(); }
    }
    imports.push({ spec: m[1], names, aliases, from: true, line: at(m.index) });
  }

  const symbols = [];
  for (const m of all(/^(?:async[ \t]+)?def[ \t]+([A-Za-z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
  for (const m of all(/^class[ \t]+([A-Za-z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'class', line: at(m.index) });
  symbols.sort((a, b) => a.line - b.line);

  const routes = [];
  const routers = {};
  for (const m of all(/^[ \t]*([A-Za-z_]\w*)\s*=\s*(?:\w+\.)?(Blueprint|APIRouter|Router)\(([^)]*)\)/gm, code)) {
    routers[m[1]] = /(?:url_)?prefix\s*=\s*["']([^"']*)["']/.exec(m[3])?.[1] || '';
  }
  for (const m of all(/^[ \t]*@([A-Za-z_]\w*)\.(route|get|post|put|patch|delete|api_route|websocket)\(\s*[rf]?["']([^"']*)["']([^\n]*)/gm, code)) {
    let methods = [m[2].toUpperCase()];
    if (m[2] === 'route' || m[2] === 'api_route') {
      // the decorator's arguments may continue over several lines, up to the next decorator or def
      const rest = code.slice(m.index + m[0].length - m[4].length, m.index + m[0].length + 400).split(/\n\s*(?:@|def |async def )/)[0];
      const ms = /methods\s*=\s*[\[(]([^\])]*)[\])]/.exec(rest);
      methods = ms ? [...ms[1].matchAll(/["'](\w+)["']/g)].map((x) => x[1].toUpperCase()) : ['GET'];
    }
    for (const method of methods) routes.push({ method, path: m[3], var: m[1], line: at(m.index) });
  }
  // Django urls.py
  for (const m of all(/\b(?:re_)?path\(\s*r?["']([^"']*)["']\s*,\s*(?!include)/g, code)) routes.push({ method: 'ANY', path: '/' + m[1].replace(/^\^|\$$/g, ''), var: null, line: at(m.index), framework: 'django' });
  routes.push(...pyHandRoutes(code, at), ...mcpTools(code, code, at, 'python'));

  const mounts = [];
  for (const m of all(/\b(register_blueprint|include_router|mount)\(\s*([A-Za-z_][\w.]*)/g, code)) {
    // the call's arguments, up to its own closing bracket: dependencies=[Depends(x)] holds brackets of its own
    let depth = 1, j = m.index + m[0].length;
    while (j < code.length && depth && j - m.index < 2000) { if (code[j] === '(') depth++; else if (code[j] === ')') depth--; j++; }
    const args = code.slice(m.index + m[0].length, j - 1);
    // FastAPI checks applied to every route of the router where it's included:
    // app.include_router(admin.router, dependencies=[Depends(require_admin)])
    const deps = m[1] === 'include_router' ? /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(args)?.[1] : null;
    const mw = deps ? [...deps.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)].map((d) => d[1].split('.').pop()) : [];
    mounts.push({ var: m[2], prefix: /(?:url_)?prefix\s*=\s*["']([^"']*)["']/.exec(args)?.[1] || '', line: at(m.index), ...(mw.length ? { mw } : {}) });
  }

  const routeLine = /^\s*@\w+\.(route|get|post|put|patch|delete)\(/;
  const { calls, hosts } = extractCalls(code, at, { skip: routeLine });
  return { imports, symbols, routes, mounts, calls, hosts, routers };
}

// ---------- Go ----------

function extractGo(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm, code)) imports.push({ spec: m[1], names: [], line: at(m.index) });
  for (const block of all(/^import\s*\(([\s\S]*?)\)/gm, code)) {
    for (const m of all(/(?:[\w.]+\s+)?"([^"]+)"/g, block[1])) imports.push({ spec: m[1], names: [], line: at(block.index) });
  }
  const symbols = [];
  for (const m of all(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, code)) symbols.push({ name: m[1], kind: 'function', line: at(m.index) });
  for (const m of all(/^type\s+([A-Z]\w*)\s+(struct|interface)?/gm, code)) symbols.push({ name: m[1], kind: m[2] || 'type', line: at(m.index) });
  const routes = [];
  for (const m of all(/\.(HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(\/[^"]*)"/g, code)) {
    const method = /^handle/i.test(m[1]) ? 'ANY' : m[1].toUpperCase();
    const p = m[2].replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/, '');
    routes.push({ method, path: p, var: null, line: at(m.index) });
  }
  const { calls, hosts } = extractCalls(code, at, { skip: /\.(HandleFunc|Handle|GET|POST)\(/ });
  return { imports, symbols, routes, mounts: [], calls, hosts };
}

// ---------- Rust ----------

function extractRust(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  for (const m of all(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm, code)) imports.push({ spec: m[1], kind: 'mod', names: [], line: at(m.index) });
  for (const m of all(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm, code)) imports.push({ spec: m[1], kind: 'use', names: [], line: at(m.index) });
  const symbols = [];
  for (const m of all(/^[ \t]*pub\s+(?:async\s+)?(fn|struct|enum|trait|type|const|static)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1] === 'fn' ? 'function' : m[1], line: at(m.index) });
  const routes = [];
  for (const m of all(/#\[(get|post|put|patch|delete)\(\s*"([^"]+)"/g, code)) routes.push({ method: m[1].toUpperCase(), path: m[2], var: null, line: at(m.index) });
  for (const m of all(/\.route\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)/g, code)) routes.push({ method: m[2].toUpperCase(), path: m[1], var: null, line: at(m.index) });
  const { calls, hosts } = extractCalls(code, at);
  return { imports, symbols, routes, mounts: [], calls, hosts };
}

// ---------- JVM ----------

function extractJvm(src) {
  const code = stripCStyle(src);
  const at = lineIndex(code);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(code)?.[1] || null;
  const imports = all(/^\s*import\s+(?:static\s+)?([\w.*]+)/gm, code).map((m) => ({ spec: m[1], names: [], line: at(m.index) }));
  const symbols = [];
  for (const m of all(/^\s*(?:public\s+|internal\s+)?(?:abstract\s+|final\s+|data\s+|sealed\s+|open\s+)*(class|interface|enum|record|object)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  const routes = [];
  const classPrefix = /@RequestMapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"[^)]*\)\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public\s+)?class/.exec(code)?.[1] || '';
  for (const m of all(/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?"([^"]*)"/g, code)) {
    if (m[1] === 'Request' && m[2] === classPrefix) continue;
    routes.push({ method: m[1] === 'Request' ? 'ANY' : m[1].toUpperCase(), path: classPrefix + m[2], var: null, line: at(m.index) });
  }
  const { calls, hosts } = extractCalls(code, at, { skip: /@\w+Mapping/ });
  return { imports, symbols, routes, mounts: [], calls, hosts, pkg };
}

// ---------- Swift ----------

/**
 * Swift: imports, declarations (kept on the file for lib/swift.mjs, which links files by the names
 * they use), Vapor and Hummingbird routes, hand-written routers, MCP tool registries and HTTP calls.
 */
function extractSwift(src) {
  const { noComments: text, code } = swiftStrip(src);
  const at = lineIndex(text);
  const imports = [...text.matchAll(IMPORT_RE)].map((m) => ({ spec: m[1], names: [], line: at(m.index) }));
  const facts = swiftFacts(code);
  const symbols = facts.decls.map((d) => ({ name: d.name, kind: d.kind, line: at(d.index) }));

  const routes = [];
  // Vapor (`app.get("todos", ":id")`, `routes.grouped("api")`, RouteCollection) and Hummingbird
  // (`router.get("/todos/:id")`, `router.group("api")`): known router values and the prefix each adds
  if (imports.some((i) => /^(Vapor|Hummingbird\w*)$/.test(i.spec))) {
    const prefix = new Map([['app', ''], ['routes', ''], ['router', '']]);
    for (const m of code.matchAll(/(\w+)(?:\s+(\w+))?\s*:\s*(?:some\s+|any\s+)?(?:RoutesBuilder|Application|Router(?:Group)?|RouterMethods)\b/g)) prefix.set(m[2] || m[1], '');
    for (const m of code.matchAll(/\b(\w+)\s*=\s*Router(?:<[^>\n]*>)?\s*\(/g)) prefix.set(m[1], '');
    const segs = (args) => args.split(',').filter((a) => !/^\s*\w+\s*:/.test(a)).flatMap((a) => [...a.matchAll(/"([^"]*)"/g)].map((x) => x[1])).map((x) => x.replace(/^\/+|\/+$/g, '')).filter(Boolean);
    const join = (...parts) => '/' + parts.filter(Boolean).join('/');
    // in source order, so a group is known before the routes on it
    const events = [
      ...[...code.matchAll(/\b(?:let|var)\s+(\w+)\s*=\s*(\w+)\.(?:grouped|group)\s*\(/g)].map((m) => ({ i: m.index, kind: 'assign', to: m[1], from: m[2], open: m.index + m[0].length - 1 })),
      ...[...code.matchAll(/\b(\w+)\.(?:group|grouped)\s*\(/g)].map((m) => ({ i: m.index, kind: 'block', from: m[1], open: m.index + m[0].length - 1 })),
      // `app.get("x") { … }`, or no arguments at all: `app.get { req in … }`
      ...[...code.matchAll(/\b(\w+)\.(get|post|put|patch|delete|head|on)\s*([({])/g)].map((m) => ({ i: m.index, kind: 'route', from: m[1], verb: m[2], open: m[3] === '(' ? m.index + m[0].length - 1 : -1 })),
    ].sort((a, b) => a.i - b.i);
    for (const e of events) {
      if (!prefix.has(e.from)) continue;
      const args = e.open < 0 ? '' : text.slice(e.open + 1, closeOf(code, e.open));
      const base = prefix.get(e.from);
      if (e.kind === 'assign') { prefix.set(e.to, join(base.slice(1), ...segs(args))); continue; }
      if (e.kind === 'block') {
        const after = code.slice(closeOf(code, e.open) + 1, closeOf(code, e.open) + 80);
        const v = /^\s*\{\s*(\w+)\s+in\b/.exec(after)?.[1];
        if (v) prefix.set(v, join(base.slice(1), ...segs(args)));
        continue;
      }
      const method = e.verb === 'on' ? (/^\s*\.(\w+)/.exec(args)?.[1] || 'ANY').toUpperCase() : e.verb.toUpperCase();
      const handler = /\buse\s*:\s*(?:self\.)?(\w+)/.exec(args)?.[1];
      routes.push({ method: HTTP_VERB.test(method) ? method : 'ANY', path: join(base.slice(1), ...segs(args)), var: e.from, line: at(e.i), framework: 'swift', ...(handler ? { handler } : {}) });
    }
  }
  // hand-written servers (NWListener and friends): `case ("POST", "/mcp")`, `case ("GET", let p) where
  // p.hasPrefix("/x")`, `switch path { case "/x": }` and `path == "/x"`
  if (/\b(NWListener|NWConnection|HTTPServer|HTTPRequest|ChannelInboundHandler|GCDWebServer)\b|\.method\b/.test(code)) {
    const hand = [];
    let off = 0;
    for (const line of text.split('\n')) {
      if (/^\s*case\b/.test(line)) {
        for (const m of line.matchAll(/\(\s*(?:"([A-Z]+)"|_|\.(\w+)|let\s+(\w+))\s*,\s*(?:"(\/[^"]*)"|let\s+(\w+))\s*\)/g)) {
          const method = m[1] || (m[2] ? m[2].toUpperCase() : 'ANY');
          const meth = HTTP_VERB.test(method) ? method : 'ANY';
          if (m[4]) hand.push(handRoute(meth, m[4], at(off)));
          else for (const p of line.matchAll(new RegExp(`\\b${m[5]}\\.hasPrefix\\(\\s*"(\\/[^"]*)"`, 'g'))) hand.push(handRoute(meth, p[1], at(off)));
        }
      }
      for (const m of line.matchAll(/\b(?:\w+\.)?path\s*(?:==\s*|\.hasPrefix\(\s*)"(\/[^"]*)"/g)) {
        const meth = [...line.matchAll(/\bmethod\s*==\s*"([A-Z]+)"/g)].map((x) => x[1]).filter((x) => HTTP_VERB.test(x));
        for (const mm of meth.length ? meth : ['ANY']) hand.push(handRoute(mm, m[1], at(off)));
      }
      off += line.length + 1;
    }
    for (const m of code.matchAll(/\bswitch\s+([^{\n]+)\{/g)) {
      if (!/\b(path|url|route|uri|endpoint)\b/i.test(m[1]) || /^\s*\(/.test(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const body = text.slice(open, closeOf(code, open));
      for (const c of body.matchAll(/^\s*case\s+([^:\n]*"\/[^\n]*?):/gm)) for (const p of c[1].matchAll(/"(\/[^"]*)"/g)) hand.push(handRoute('ANY', p[1], at(open + c.index + c[0].indexOf(p[0]))));
    }
    routes.push(...tidyHand(hand));
  }
  routes.push(...mcpTools(text, code, at, 'swift'));

  const routeLine = /^\s*case\b[^\n]*"\/|\bpath\s*(?:==|\.hasPrefix)|\.(get|post|put|patch|delete|on|group|grouped)\s*\(\s*"/;
  const { calls, hosts } = extractCalls(text, at, { skip: routeLine });
  return { imports, symbols, routes, mounts: [], calls, hosts, swift: facts };
}

// ---------- small ones ----------

function extractSimple(src, lang) {
  const code = lang === 'ruby' ? stripHash(src) : stripCStyle(src);
  const at = lineIndex(code);
  const imports = [];
  if (lang === 'ruby') for (const m of all(/\brequire_relative\s*\(?\s*["']([^"']+)["']/g, code)) imports.push({ spec: './' + m[1].replace(/^\.\//, ''), names: [], line: at(m.index) });
  if (lang === 'c' || lang === 'cpp' || lang === 'objc') for (const m of all(/^\s*#\s*(?:include|import)\s+"([^"]+)"/gm, code)) imports.push({ spec: m[1], names: [], kind: 'include', line: at(m.index) });
  if (lang === 'php') for (const m of all(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?["']([^"']+)["']/g, code)) imports.push({ spec: m[1].startsWith('/') ? '.' + m[1] : m[1], names: [], line: at(m.index) });
  if (lang === 'css') for (const m of all(/@(?:import|use|forward)\s+(?:url\()?["']([^"']+)["']/g, code)) imports.push({ spec: m[1].startsWith('.') ? m[1] : './' + m[1], names: [], line: at(m.index) });
  const symbols = [];
  if (lang === 'ruby') for (const m of all(/^\s*(class|module)\s+([A-Z][\w:]*)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  if (lang === 'csharp') for (const m of all(/^\s*public\s+(?:static\s+|abstract\s+|sealed\s+|partial\s+)*(class|interface|enum|record|struct)\s+(\w+)/gm, code)) symbols.push({ name: m[2], kind: m[1], line: at(m.index) });
  const { calls, hosts } = ['ruby', 'php', 'csharp', 'dart', 'kotlin'].includes(lang) ? extractCalls(code, at) : { calls: [], hosts: [] };
  return { imports, symbols, routes: [], mounts: [], calls, hosts };
}

function extractByLang(src, lang, filePath) {
  switch (lang) {
    case 'typescript': case 'javascript': case 'vue': case 'svelte': case 'astro': return extractJs(src, filePath);
    case 'python': return extractPy(src);
    case 'go': return extractGo(src);
    case 'rust': return extractRust(src);
    case 'java': case 'kotlin': case 'scala': case 'groovy': return extractJvm(src);
    case 'swift': return extractSwift(src);
    default: return extractSimple(src, lang);
  }
}

export function extract(src, lang, filePath) {
  const r = extractByLang(src, lang, filePath);
  addDocs(src, lang, r);
  return r;
}

// ---------- docs: file headers, docstrings, JSDoc, route handlers ----------

const HASH_LANGS = new Set(['python', 'ruby', 'shell', 'powershell', 'r', 'elixir', 'perl']);
const LICENSE = /copyright|license|spdx|eslint-disable|@ts-nocheck|prettier-ignore|^-\*-|coding[:=]|generated by|do not edit/i;

export function cleanDoc(text) {
  if (!text) return null;
  const lines = text.split('\n')
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#+|"""|''')\s?/, '').replace(/(\*\/|"""|''')\s*$/, '').trim())
    .filter((l) => l && !/^@\w+/.test(l) && !/^[-=*_]{3,}$/.test(l));
  // first paragraph only
  const para = [];
  for (const l of lines) { if (!l && para.length) break; para.push(l); }
  let s = para.join(' ').replace(/\s+/g, ' ').trim();
  if (!s || s.length < 8 || LICENSE.test(s)) return null;
  const sentence = /^(.{20,220}?[.!?])(\s|$)/.exec(s);
  s = sentence ? sentence[1] : s.length > 220 ? s.slice(0, 217).replace(/\s+\S*$/, '') + '…' : s;
  return s;
}

function pyDocAfter(lines, idx) {
  // idx: 0-based line of the def/class (or -1 for module). Find the end of the signature, then a string literal.
  let i = idx;
  if (idx >= 0) {
    while (i < lines.length && i < idx + 20 && !/:\s*(#.*)?$/.test(lines[i])) i++;
    i++;
  } else i = 0;
  while (i < lines.length && (!lines[i].trim() || (idx < 0 && /^\s*(#|from __future__)/.test(lines[i])))) i++;
  const first = lines[i];
  if (!first) return null;
  const m = /^\s*[rRbBuUfF]?("""|''')(.*)$/.exec(first);
  if (!m) return idx < 0 ? hashHeader(lines) : null;
  const q = m[1];
  if (m[2].includes(q)) return cleanDoc(m[2].slice(0, m[2].indexOf(q)));
  const buf = [m[2]];
  for (let j = i + 1; j < lines.length && j < i + 40; j++) {
    const k = lines[j].indexOf(q);
    if (k >= 0) { buf.push(lines[j].slice(0, k)); break; }
    buf.push(lines[j]);
  }
  return cleanDoc(buf.join('\n'));
}

function hashHeader(lines) {
  const buf = [];
  for (const l of lines) {
    if (/^#!/.test(l)) continue;
    if (/^\s*#/.test(l)) { buf.push(l); continue; }
    if (!l.trim() && !buf.length) continue;
    break;
  }
  return cleanDoc(buf.join('\n'));
}

function commentBefore(lines, idx) {
  // idx: 0-based line of the declaration. Skip decorators/annotations, then read a /** */ block or // run.
  let i = idx - 1;
  while (i >= 0 && /^\s*@/.test(lines[i])) i--;
  if (i < 0) return null;
  if (/\*\/\s*$/.test(lines[i])) {
    const end = i;
    while (i >= 0 && !/\/\*/.test(lines[i])) i--;
    return i >= 0 ? cleanDoc(lines.slice(i, end + 1).join('\n')) : null;
  }
  const buf = [];
  while (i >= 0 && /^\s*(\/\/|#(?!!))/.test(lines[i])) buf.unshift(lines[i--]);
  return buf.length ? cleanDoc(buf.join('\n')) : null;
}

function headerComment(lines) {
  let i = 0;
  while (i < lines.length && (!lines[i].trim() || /^\s*['"]use (client|server|strict)['"];?\s*$/.test(lines[i]) || /^#!/.test(lines[i]))) i++;
  const l = lines[i] || '';
  if (/^\s*\/\*/.test(l)) {
    const start = i;
    while (i < lines.length && !/\*\//.test(lines[i])) i++;
    return cleanDoc(lines.slice(start, i + 1).join('\n'));
  }
  const buf = [];
  while (i < lines.length && /^\s*\/\//.test(lines[i])) buf.push(lines[i++]);
  return cleanDoc(buf.join('\n'));
}

/**
 * A Swift file's header comment, minus Xcode's template lines (file name, project name, "Created by",
 * copyright), so `//  Store.swift  //  Household  //  Created by…` gives nothing rather than noise.
 */
function swiftHeader(lines) {
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^\s*\/\*/.test(lines[i] || '')) return headerComment(lines);
  const buf = [];
  for (; i < lines.length && /^\s*\/\//.test(lines[i]); i++) buf.push(lines[i]);
  const kept = buf.filter((l) => !/^\s*\/\/+\s*([\w+.-]+\.swift|Created by\b.*|Copyright\b.*|©.*|All rights reserved\.?|swift-tools-version:.*)?\s*$/i.test(l));
  // what's left of a template is the project or target name alone on a line
  if (kept.length === 1 && buf.length > kept.length && /^\s*\/\/+\s*[\w -]{1,40}$/.test(kept[0]) && !/[.!?]/.test(kept[0])) return null;
  return cleanDoc(kept.join('\n'));
}

function addDocs(src, lang, r) {
  const lines = src.split('\n');
  r.doc = lang === 'python' ? pyDocAfter(lines, -1) : lang === 'swift' ? swiftHeader(lines) : HASH_LANGS.has(lang) ? hashHeader(lines) : headerComment(lines);
  for (const s of r.symbols || []) {
    const d = lang === 'python' ? pyDocAfter(lines, s.line - 1) : commentBefore(lines, s.line - 1);
    if (d) s.doc = d;
  }
  // a Swift file without a header says what it is in the doc comment on its first declaration
  if (lang === 'swift' && !r.doc) r.doc = [...(r.symbols || [])].sort((a, b) => a.line - b.line).find((s) => s.doc)?.doc || null;
  // A route's handler is the first declaration after it (decorator-style frameworks).
  // (a Firebase function's export isn't the handler of the Express routes above it)
  const fbNames = new Set((r.routes || []).filter((rt) => rt.framework === 'firebase').map((rt) => rt.handler));
  const syms = (r.symbols || []).filter((s) => !fbNames.has(s.name)).sort((a, b) => a.line - b.line);
  for (const rt of r.routes || []) {
    if (rt.framework === 'next') { rt.handler = rt.method; continue; }
    // an MCP tool decorating a function (Python's @mcp.tool) is described by that function's docstring
    if (rt.framework === 'mcp') { if (!rt.doc) { const d = (r.symbols || []).find((x) => x.name === rt.handler)?.doc; if (d) rt.doc = d; } continue; }
    if (rt.framework === 'handwritten') continue; // no handler declaration follows these
    if (rt.framework === 'firebase') { const d = r.symbols.find((s) => s.name === rt.handler)?.doc || commentBefore(lines, rt.line - 1); if (d) rt.doc = d; continue; }
    const h = syms.find((s) => s.line >= rt.line && s.line - rt.line <= 12);
    if (h) { rt.handler = h.name; if (h.doc) rt.doc = h.doc; }
    else if (lang === 'python') {
      const m = lines.slice(rt.line, rt.line + 12).findIndex((l) => /^\s*(async\s+)?def\s+\w+/.test(l));
      if (m >= 0) {
        rt.handler = /def\s+(\w+)/.exec(lines[rt.line + m])[1];
        const d = pyDocAfter(lines, rt.line + m);
        if (d) rt.doc = d;
      }
    }
  }
}
