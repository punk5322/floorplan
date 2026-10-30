// Swift: modules (SwiftPM, XcodeGen, Xcode projects), import edges, and file-to-file links from a
// light symbol index, since Swift files in one module never import each other.
//
// swiftStrip(src)            — the source with comments blanked (strings kept) and, separately, with
//                              string contents blanked too (interpolated code kept). Offsets never move.
// swiftFacts(src)            — per-file declarations, references and imports, used by swiftLinks.
// swiftModules(root, paths)  — targets and their folders, from Package.swift, project.yml or project.pbxproj.
// swiftLinks(root, files)    — file->file edges (imports of local modules + symbol uses) and outside parts.
import fs from 'node:fs';
import path from 'node:path';

const P = path.posix;

// ---------- lexing ----------

/**
 * One pass over Swift source. `noComments` keeps strings (routes, URLs and tool names live there);
 * `code` also blanks string contents, keeping `\(…)` interpolations, which are code. Handles nested
 * block comments, multi-line `"""` strings and raw `#"…"#` strings. Newlines always survive.
 */
export function swiftStrip(src) {
  const a = src.split(''), b = src.split('');
  const blank = (arr, j) => { if (arr[j] !== '\n') arr[j] = ' '; };
  const n = src.length;
  const stack = []; // interpolations we are inside: the string to return to, and the outer paren depth
  let str = null, depth = 0, i = 0;
  while (i < n) {
    const c = src[i];
    if (!str) {
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') { blank(a, i); blank(b, i); i++; } continue; }
      if (c === '/' && src[i + 1] === '*') {
        let d = 0;
        do {
          if (src[i] === '/' && src[i + 1] === '*') { d++; blank(a, i); blank(b, i); blank(a, i + 1); blank(b, i + 1); i += 2; }
          else if (src[i] === '*' && src[i + 1] === '/') { d--; blank(a, i); blank(b, i); blank(a, i + 1); blank(b, i + 1); i += 2; }
          else { blank(a, i); blank(b, i); i++; }
        } while (i < n && d > 0);
        continue;
      }
      if (c === '"' || (c === '#' && /^#+"/.test(src.slice(i, i + 8)))) {
        let h = 0;
        while (src[i + h] === '#') h++;
        const multi = src.startsWith('"""', i + h);
        i += h + (multi ? 3 : 1);
        str = { h, multi, close: (multi ? '"""' : '"') + '#'.repeat(h) };
        continue;
      }
      if (stack.length) {
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) { ({ str, depth } = stack.pop()); i++; continue; }
      }
      i++;
      continue;
    }
    if (src.startsWith(str.close, i)) { i += str.close.length; str = null; continue; }
    if (c === '\n' && !str.multi) { str = null; i++; continue; } // unterminated: recover at the line end
    if (c === '\\' && src.startsWith('#'.repeat(str.h), i + 1)) {
      const k = i + 1 + str.h;
      if (src[k] === '(') { for (let j = i; j <= k; j++) blank(b, j); stack.push({ str, depth }); str = null; depth = 1; i = k + 1; continue; }
      for (let j = i; j <= k && j < n; j++) blank(b, j);
      i = k + 1;
      continue;
    }
    blank(b, i);
    i++;
  }
  return { noComments: a.join(''), code: b.join('') };
}

/** Index of the bracket closing the one at `open` (in text whose strings are already blanked). */
export function closeOf(code, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const want = [pairs[code[open]]];
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (pairs[c]) want.push(pairs[c]);
    else if (c === want[want.length - 1]) { want.pop(); if (!want.length) return i; }
  }
  return code.length - 1;
}

// ---------- per-file facts ----------

const DECL = /(?<![\w.])((?:(?:public|private|fileprivate|internal|package|open|final|static|class|indirect|nonisolated|override|mutating|nonmutating|lazy|weak|unowned|convenience|required|dynamic|(?:private|fileprivate|internal|public)\(set\)|@\w+(?:\([^()\n]*\))?)\s+)*)(struct|class|enum|actor|protocol|typealias|extension|func|let|var|macro)\s+`?([A-Za-z_]\w*)/g;
const TYPE_KW = new Set(['struct', 'class', 'enum', 'actor', 'protocol', 'typealias']);
const KIND = { struct: 'struct', class: 'class', enum: 'enum', actor: 'class', protocol: 'interface', typealias: 'type', func: 'function', let: 'const', var: 'const', macro: 'function' };
const KEYWORDS = new Set(['func', 'var', 'let', 'class', 'struct', 'enum', 'actor', 'protocol', 'extension', 'typealias', 'init', 'subscript', 'static']);
// a bare identifier: not a member (`.name`), not an argument label (`(name:` / `, name:`)
const REF = /(?<![\w.$#])([A-Za-z_]\w*)(?![\w])(?!(?<=[(,]\s*[A-Za-z_]\w*)\s*:)/g;

/**
 * Declarations other files can use (top-level types, functions and constants, plus public nested
 * types), the names this file refers to, and what it imports. `private`/`fileprivate` ones stay out.
 */
export function swiftFacts(code) {
  const depthAt = new Uint16Array(code.length + 1);
  let d = 0;
  for (let i = 0; i < code.length; i++) { depthAt[i] = d; const c = code[i]; if (c === '{') d++; else if (c === '}' && d > 0) d--; }
  const decls = [], extended = [];
  for (const m of code.matchAll(DECL)) {
    const [, mods, kw, name] = m;
    const at = m.index + m[1].length;
    if (KEYWORDS.has(name)) continue;
    const dep = depthAt[at];
    if (kw === 'extension') { if (dep === 0) extended.push(name); continue; }
    if (/\b(private|fileprivate)\b(?!\()/.test(mods)) continue;
    if (dep > 0 && !(TYPE_KW.has(kw) && /\b(public|open)\b/.test(mods))) continue;
    decls.push({ name, kind: KIND[kw], index: at });
  }
  const refs = new Set();
  for (const m of code.matchAll(REF)) refs.add(m[1]);
  // names this file binds itself (locals, parameters, closure arguments): `routes` in
  // `func boot(routes: RoutesBuilder)` is that parameter, not a top-level `func routes` elsewhere
  const locals = new Set();
  for (const m of code.matchAll(/\b(?:let|var|for)\s+`?([A-Za-z_]\w*)/g)) locals.add(m[1]);
  for (const m of code.matchAll(/[(,]\s*(?:\w+\s+)?([a-z_]\w*)\s*:\s*(?:inout\s+|some\s+|any\s+|@\w+\s+)*[A-Z[(]/g)) locals.add(m[1]);
  for (const m of code.matchAll(/\{\s*\(?\s*([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)\s*\)?\s+in\b/g)) for (const n of m[1].split(',')) locals.add(n.trim());
  return { decls, extended, refs, locals };
}

export const IMPORT_RE = /^[ \t]*(?:@[\w]+(?:\([^)\n]*\))?\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func|actor)\s+)?([A-Za-z_]\w*)/gm;

// ---------- Apple frameworks ----------

// Frameworks that are just the platform (UI, basics, concurrency): no outside part for these.
const PLATFORM = new Set(('Foundation SwiftUI SwiftUICore UIKit AppKit WatchKit Combine os OSLog Observation Dispatch Darwin Glibc Network ' +
  'CoreGraphics CoreImage QuartzCore CoreFoundation CoreText CoreServices CoreMedia CoreVideo CoreAudio UniformTypeIdentifiers ' +
  'XCTest Testing Charts CryptoKit Accelerate simd CoreTransferable TipKit Synchronization RegexBuilder Swift _Concurrency ' +
  'SafariServices QuickLook QuickLookThumbnailing PDFKit LinkPresentation ImageIO MobileCoreServices SystemConfiguration ' +
  'BackgroundTasks Intents IntentsUI AudioToolbox CoreHaptics SpriteKit SceneKit GameplayKit Metal MetalKit RealityKit ARKit ' +
  'ServiceManagement ExtensionFoundation ExtensionKit Social MessageUI Messages NotificationCenter AdSupport AppTrackingTransparency ' +
  'PackageDescription').split(' '));
/** Frameworks that stand for something outside the app (a service, a store of the person's data), grouped by what people call it. */
export const APPLE_GROUPS = {
  CloudKit: 'iCloud', HealthKit: 'Apple Health', EventKit: 'Calendar & Reminders', EventKitUI: 'Calendar & Reminders',
  WeatherKit: 'Apple Weather', HomeKit: 'Apple Home', MapKit: 'Maps & location', CoreLocation: 'Maps & location',
  StoreKit: 'App Store purchases', UserNotifications: 'Notifications', WidgetKit: 'Widgets & Live Activities', ActivityKit: 'Widgets & Live Activities',
  CoreData: 'On-device database', SwiftData: 'On-device database', Speech: 'Speech recognition', AVFoundation: 'Camera & audio', AVKit: 'Camera & audio',
  Vision: 'Image recognition', VisionKit: 'Image recognition', Contacts: 'Contacts', ContactsUI: 'Contacts', Photos: 'Photos', PhotosUI: 'Photos',
  LocalAuthentication: 'Face ID & Touch ID', Security: 'Keychain', AuthenticationServices: 'Sign in with Apple', WatchConnectivity: 'iPhone and Watch link',
  CoreMotion: 'Motion & fitness', FoundationModels: 'Apple Intelligence', AppIntents: 'Siri & Shortcuts', CoreSpotlight: 'Spotlight',
  GameKit: 'Game Center', MusicKit: 'Music', MediaPlayer: 'Music', CoreBluetooth: 'Bluetooth', NearbyInteraction: 'Nearby devices',
  CoreNFC: 'NFC', PassKit: 'Apple Wallet & Pay', FamilyControls: 'Screen Time', ManagedSettings: 'Screen Time', DeviceActivity: 'Screen Time',
};

// ---------- modules ----------

const strs = (s) => [...s.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]);
const argOf = (s, label) => new RegExp(`\\b${label}\\s*:\\s*"([^"]*)"`).exec(s)?.[1];
/** The bracketed list after `label:` in a manifest call, or ''. */
function listOf(s, label) {
  const m = new RegExp(`\\b${label}\\s*:\\s*\\[`).exec(s);
  if (!m) return '';
  const open = m.index + m[0].length - 1;
  return s.slice(open, closeOf(swiftStrip(s).code, open) + 1);
}
/** Each `.kind(…)` call in a manifest, with its argument text. */
function calls(text, kinds) {
  const code = swiftStrip(text).code;
  const out = [];
  for (const m of code.matchAll(new RegExp(`\\.(${kinds})\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1;
    out.push({ kind: m[1], args: text.slice(open + 1, closeOf(code, open)) });
  }
  return out;
}

/** Targets in a Package.swift: name, folder, dependencies (local targets and products), and remote packages. */
export function parsePackageSwift(text, dir) {
  const src = swiftStrip(text).noComments;
  const modules = [];
  for (const t of calls(src, 'target|executableTarget|testTarget|macro|plugin')) {
    const name = argOf(t.args, 'name');
    if (!name) continue;
    const deps = listOf(t.args, 'dependencies');
    const products = [...deps.matchAll(/\.product\s*\(\s*name\s*:\s*"([^"]+)"(?:\s*,\s*package\s*:\s*"([^"]+)")?/g)].map((m) => m[1]);
    const named = strs(deps.replace(/\.product\s*\([^)]*\)/g, ''));
    const p = argOf(t.args, 'path') || `${t.kind === 'testTarget' ? 'Tests' : t.kind === 'plugin' ? 'Plugins' : 'Sources'}/${name}`;
    modules.push({ name, dirs: [P.normalize(P.join(dir, p))], kind: 'swiftpm', test: t.kind === 'testTarget', deps: [...new Set([...named, ...products])] });
  }
  const remote = calls(src, 'package').map((c) => argOf(c.args, 'url')).filter(Boolean).map((u) => u.replace(/\.git$/, '').split('/').pop());
  const products = Object.fromEntries(calls(src, 'library|executable').map((c) => [argOf(c.args, 'name'), strs(listOf(c.args, 'targets'))]).filter(([k]) => k));
  return { modules, remote, products };
}

/**
 * Targets in an XcodeGen project.yml, read line by line (no YAML library): each target's `sources`
 * (inline list, single value, or `- path:` entries) and its `target:`/`package:` dependencies.
 */
export function parseXcodeGen(text, dir) {
  const lines = text.split('\n');
  const ind = (l) => /^ */.exec(l)[0].length;
  const unq = (s) => s.trim().replace(/^["']|["']$/g, '');
  const modules = [];
  const start = lines.findIndex((l) => /^targets:\s*$/.test(l));
  if (start < 0) return { modules };
  let tInd = -1, cur = null, key = null, keyInd = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const n = ind(l);
    if (n === 0) break;
    if (tInd < 0) tInd = n;
    if (n === tInd) {
      const m = /^\s*["']?([\w .-]+?)["']?:\s*$/.exec(l);
      cur = m ? { name: m[1], dirs: [], kind: 'xcodegen', test: false, deps: [] } : null;
      if (cur) modules.push(cur);
      key = null;
      continue;
    }
    if (!cur) continue;
    const kv = /^\s*([\w]+):\s*(.*)$/.exec(l);
    if (kv && n <= tInd + 4 && !/^\s*-/.test(l)) {
      key = kv[1]; keyInd = n;
      const v = kv[2].replace(/\s+#.*$/, '').trim();
      if (key === 'type' && /test/i.test(v)) cur.test = true;
      if (key === 'sources' && v) for (const s of v.replace(/^\[|\]$/g, '').split(',').map(unq).filter(Boolean)) cur.dirs.push(P.normalize(P.join(dir, s)));
      continue;
    }
    if (n <= keyInd) { key = null; continue; }
    const item = /^\s*-\s*(?:(\w+):\s*)?(.+)$/.exec(l);
    if (!item) continue;
    const v = unq(item[2].replace(/\s+#.*$/, ''));
    if (key === 'sources' && (!item[1] || item[1] === 'path')) cur.dirs.push(P.normalize(P.join(dir, v)));
    if (key === 'dependencies' && (item[1] === 'target' || item[1] === 'package')) cur.deps.push(v.split('/')[0]);
  }
  const packages = {};
  const pi = lines.findIndex((l) => /^packages:\s*$/.test(l));
  if (pi >= 0) {
    let name = null;
    for (let i = pi + 1; i < lines.length && (!lines[i].trim() || ind(lines[i]) > 0); i++) {
      const m = /^\s+([\w.-]+):\s*$/.exec(lines[i]);
      if (m) { name = m[1]; continue; }
      const kv = /^\s+(path|url):\s*(.+)$/.exec(lines[i]);
      if (name && kv) packages[name] = { [kv[1]]: unq(kv[2]) };
    }
  }
  return { modules, packages };
}

/**
 * Targets in an Xcode project, for projects without a manifest: each native target's name and its
 * folders (Xcode 16 synchronized folders; otherwise a top-level folder named like the target).
 * shortcut: classic group-by-group file membership isn't read, upgrade if such projects map badly.
 */
export function parsePbxproj(text, dir, hasDir) {
  const groupPath = new Map();
  for (const m of text.matchAll(/(\w+) \/\* [^*]*\*\/ = \{\s*isa = PBXFileSystemSynchronizedRootGroup;([\s\S]*?)\n\t\t\};/g)) {
    const p = /\bpath = ("[^"]*"|[^;]+);/.exec(m[2])?.[1].replace(/"/g, '');
    if (p) groupPath.set(m[1], p);
  }
  const modules = [];
  for (const m of text.matchAll(/\w+ \/\* [^*]*\*\/ = \{\s*isa = PBXNativeTarget;([\s\S]*?)\n\t\t\};/g)) {
    const body = m[1];
    const name = /\bname = ("[^"]*"|[^;]+);/.exec(body)?.[1].replace(/"/g, '');
    if (!name) continue;
    const sync = /fileSystemSynchronizedGroups = \(([^)]*)\)/.exec(body)?.[1] || '';
    const dirs = [...sync.matchAll(/(\w+) \/\*/g)].map((g) => groupPath.get(g[1])).filter(Boolean).map((p) => P.normalize(P.join(dir, p)));
    if (!dirs.length && hasDir(P.join(dir, name))) dirs.push(P.normalize(P.join(dir, name)));
    const test = /productType = "com\.apple\.product-type\.bundle\.(unit|ui)-test"/.test(body);
    modules.push({ name, dirs, kind: 'xcode', test, deps: [] });
  }
  return { modules };
}

/** Every Swift module in the codebase, from whichever manifests it has. */
export function swiftModules(root, paths) {
  const read = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch { return ''; } };
  const dirSet = new Set();
  for (const p of paths) { let d = P.dirname(p); while (d !== '.' && !dirSet.has(d)) { dirSet.add(d); d = P.dirname(d); } }
  const hasDir = (d) => dirSet.has(P.normalize(d));
  const modules = [], remote = new Set(), products = {};
  const ymlDirs = new Set();
  for (const p of paths.filter((p) => P.basename(p) === 'project.yml').sort()) {
    const txt = read(p);
    if (!/^targets:/m.test(txt)) continue;
    const r = parseXcodeGen(txt, P.dirname(p));
    modules.push(...r.modules);
    ymlDirs.add(P.dirname(p));
  }
  for (const p of paths.filter((p) => P.basename(p) === 'Package.swift').sort()) {
    const r = parsePackageSwift(read(p), P.dirname(p));
    modules.push(...r.modules);
    r.remote.forEach((x) => remote.add(x));
    Object.assign(products, r.products);
  }
  for (const p of paths.filter((p) => p.endsWith('.xcodeproj/project.pbxproj')).sort()) {
    const dir = P.dirname(P.dirname(p));
    if (ymlDirs.has(dir)) continue; // XcodeGen generated it; project.yml already said what's in it
    const r = parsePbxproj(read(p), dir, hasDir);
    for (const m of r.modules) if (!modules.some((x) => x.name === m.name)) modules.push(m);
  }
  for (const m of modules) m.dirs = m.dirs.map((d) => (d === '.' ? '' : d));
  return { modules, remote: [...remote], products };
}

// ---------- links ----------

/** Above this share of Swift files referring to one name, the name is everywhere and its edges are noise. */
export const UBIQUITOUS_SHARE = 0.4;
const UBIQUITOUS_MIN_FILES = 10;

/**
 * Files: scanned Swift files with { path, swift: { decls, extended, refs }, imports: [{ spec, line }] }.
 * Returns { edges: [{ from, to, names, count }], externals: [{ from, pkg, count }], modules, fileModule,
 *           dropped: [names too common to link], counts }.
 *
 * Rules:
 * - Each file belongs to the module whose folder holds it most specifically; files outside every
 *   module form one module per top folder.
 * - File A links to file B when A uses (as a bare word, outside comments and strings) a name B declares,
 *   and B is in A's module or in a module A imports. A function or constant name A binds itself
 *   (a local, a parameter, a closure argument) is A's own. Same-module declarations win over imported ones;
 *   a name declared in more than 3 places is ambiguous and skipped.
 * - A name used by more than 40% of the Swift files (when there are at least 10) links nothing.
 * - `import X` of a local module is shown by those links; of anything else it goes to an outside part
 *   (`apple:<group>` for meaningful Apple frameworks, `swiftpm:<name>` for packages), and plain platform
 *   frameworks (Foundation, SwiftUI…) are dropped.
 */
export function swiftLinks(root, files, allPaths) {
  const swift = files.filter((f) => f.lang === 'swift' && f.swift);
  const { modules, remote, products } = swiftModules(root, allPaths);
  const owners = modules.flatMap((m) => m.dirs.map((d) => ({ d, m })));
  const fileModule = new Map();
  for (const f of swift) {
    let best = null;
    for (const o of owners) if ((o.d === '' || f.path.startsWith(o.d + '/')) && (!best || o.d.length > best.d.length)) best = o;
    fileModule.set(f.path, best ? best.m.name : `(${f.path.split('/')[0]})`);
  }
  const local = new Set(modules.map((m) => m.name));
  for (const [prod, targets] of Object.entries(products)) if (targets.length) local.add(prod);
  const moduleOf = (name) => (products[name]?.length && !modules.some((m) => m.name === name) ? products[name][0] : name);

  const index = new Map(); // name -> [{ file, module }]
  for (const f of swift) for (const d of f.swift.decls) {
    if (!index.has(d.name)) index.set(d.name, []);
    const list = index.get(d.name);
    if (!list.some((x) => x.file === f.path)) list.push({ file: f.path, module: fileModule.get(f.path), value: d.kind === 'function' || d.kind === 'const' });
  }
  const imported = (f) => new Set((f.imports || []).map((i) => moduleOf(i.spec)));

  // first pass: who refers to what
  const uses = new Map(); // file -> Map(target -> Set(name))
  const usedBy = new Map(); // name -> Set(file)
  for (const f of swift) {
    const mod = fileModule.get(f.path), imps = imported(f);
    const own = new Set(f.swift.decls.map((d) => d.name));
    for (const name of new Set([...f.swift.refs, ...f.swift.extended])) {
      if (own.has(name)) continue;
      const cands = index.get(name);
      if (!cands) continue;
      const shadowed = f.swift.locals?.has(name);
      const visible = cands.filter((c) => c.file !== f.path && (c.module === mod || imps.has(c.module)) && !(shadowed && c.value));
      const same = visible.filter((c) => c.module === mod);
      const pick = same.length ? same : visible;
      if (!pick.length || pick.length > 3) continue;
      if (!usedBy.has(name)) usedBy.set(name, new Set());
      usedBy.get(name).add(f.path);
      if (!uses.has(f.path)) uses.set(f.path, new Map());
      for (const c of pick) {
        const m = uses.get(f.path);
        if (!m.has(c.file)) m.set(c.file, new Set());
        m.get(c.file).add(name);
      }
    }
  }
  const limit = swift.length >= UBIQUITOUS_MIN_FILES ? swift.length * UBIQUITOUS_SHARE : Infinity;
  const dropped = [...usedBy].filter(([, s]) => s.size > limit).map(([n]) => n).sort();
  const drop = new Set(dropped);
  const edges = [];
  for (const [from, m] of uses) for (const [to, names] of m) {
    const kept = [...names].filter((n) => !drop.has(n)).sort();
    if (kept.length) edges.push({ from, to, names: kept.slice(0, 20), count: kept.length });
  }

  const externals = [];
  for (const f of swift) for (const imp of f.imports || []) {
    const name = imp.spec;
    if (local.has(name) || PLATFORM.has(name)) continue;
    const pkg = APPLE_GROUPS[name] ? `apple:${APPLE_GROUPS[name]}` : `swiftpm:${name}`;
    externals.push({ from: f.path, pkg });
  }
  return { edges, externals, modules, remote, fileModule, dropped, counts: { files: swift.length, edges: edges.length } };
}
