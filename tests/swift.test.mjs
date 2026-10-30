// Swift: modules come from Package.swift, project.yml or the Xcode project; `import X` and the names a
// file uses link it to other files; comments and strings never do; doc comments describe files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, lib, makeProject, run, readJson, readGraph, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { swiftStrip, swiftLinks, parsePbxproj, parseXcodeGen, parsePackageSwift } = await lib('swift.mjs');

let root, scan, graph, summary;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'swift-app', summary: 'Test fixture.' },
    nodes: [
      { id: 'app', label: 'iPhone app', kind: 'ui', summary: 'The app.', paths: ['App', 'Watch'] },
      { id: 'kit', label: 'Shared code', kind: 'library', summary: 'The Kit package.', paths: ['Packages/Kit'] },
      { id: 'icloud', label: 'iCloud', kind: 'external', summary: 'Apple’s cloud.', packages: ['apple:iCloud'] },
    ],
  } });
  fs.cpSync(path.join(REPO, 'tests', 'fixtures', 'swift-app'), root, { recursive: true });
  summary = run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  scan = readJson(path.join(root, 'floorplan', '.cache', 'scan.json'));
  graph = readGraph(root);
});
after(() => cleanup(root));

const edgeList = () => scan.edges.map((e) => `${e.from} -> ${e.to}: ${(e.names || []).join(',')}`).sort();

test('every Swift file belongs to a module, from Package.swift and project.yml', () => {
  const mod = Object.fromEntries(scan.files.filter((f) => f.module && !f.path.endsWith('Package.swift')).map((f) => [f.path, f.module]));
  assert.deepEqual(mod, {
    'App/CartScreen.swift': 'Shop',
    'App/ShopApp.swift': 'Shop',
    'Packages/Kit/Sources/KitCore/Cart.swift': 'KitCore',
    'Packages/Kit/Sources/KitCore/PriceList.swift': 'KitCore',
    'Packages/Kit/Sources/KitCore/Receipt.swift': 'KitCore',
    'Packages/Kit/Sources/KitUI/CartView.swift': 'KitUI',
    'Packages/Kit/Tests/KitCoreTests/CartTests.swift': 'KitCoreTests',
    'Watch/WatchApp.swift': 'ShopWatch',
  });
  const kit = scan.swift.modules.find((m) => m.name === 'KitUI');
  assert.deepEqual(kit.deps, ['KitCore']);
  assert.deepEqual(scan.swift.remote, ['swift-collections']);
  assert.match(summary, /SWIFT MODULES/);
  assert.match(summary, /KitCore {2,}swiftpm/);
});

test('imports and the names a file uses link it to the files declaring them, inside a module and across', () => {
  assert.deepEqual(edgeList(), [
    'App/CartScreen.swift -> Packages/Kit/Sources/KitCore/Cart.swift: Cart',
    'App/CartScreen.swift -> Packages/Kit/Sources/KitCore/PriceList.swift: PriceList',
    'App/CartScreen.swift -> Packages/Kit/Sources/KitUI/CartView.swift: CartView',
    'App/ShopApp.swift -> App/CartScreen.swift: CartScreen',
    'Packages/Kit/Sources/KitCore/Cart.swift -> Packages/Kit/Sources/KitCore/PriceList.swift: PriceList',
    'Packages/Kit/Sources/KitUI/CartView.swift -> Packages/Kit/Sources/KitCore/Cart.swift: Cart,cartTotal',
    'Packages/Kit/Sources/KitUI/CartView.swift -> Packages/Kit/Sources/KitCore/PriceList.swift: PriceList',
    'Packages/Kit/Sources/KitUI/CartView.swift -> Packages/Kit/Sources/KitCore/Receipt.swift: Format',
    'Packages/Kit/Tests/KitCoreTests/CartTests.swift -> Packages/Kit/Sources/KitCore/Cart.swift: Cart,cartTotal',
    'Packages/Kit/Tests/KitCoreTests/CartTests.swift -> Packages/Kit/Sources/KitCore/PriceList.swift: PriceList',
    'Watch/WatchApp.swift -> Packages/Kit/Sources/KitCore/Cart.swift: Cart,cartTotal',
    'Watch/WatchApp.swift -> Packages/Kit/Sources/KitCore/PriceList.swift: PriceList',
  ]);
});

test('names inside comments, strings, multi-line and raw strings make no links; interpolated code does', () => {
  // Receipt.swift mentions Cart and PriceList only in a comment and in strings, and calls Format in "\(…)"
  assert.ok(!scan.edges.some((e) => e.from.endsWith('Receipt.swift')), 'Receipt links to nothing');
  const { code, noComments } = swiftStrip('let a = "x \\(Cart.total) y" // Cart\n/* Cart /* nested */ Cart */ let b = #"\\(Cart)"#\nlet c = """\n  Cart\n  """');
  assert.deepEqual([...code.matchAll(/Cart/g)].length, 1, 'only the interpolated Cart is code');
  assert.ok(noComments.includes('"x \\(Cart.total) y"'), 'strings stay in the comment-free text');
  assert.ok(!noComments.includes('nested'));
  assert.equal(code.split('\n').length, 5, 'line numbers never move');
});

test('Apple frameworks become outside parts only where they mean something; packages are outside libraries', () => {
  const ext = scan.externals.map((e) => e.id).sort();
  assert.deepEqual(ext, ['apple:Apple Health', 'apple:iCloud', 'swiftpm:Collections']);
  assert.ok(graph.links.some((l) => l.a === 'f:App/ShopApp.swift' && l.b === 'n:icloud'), 'import CloudKit reaches the iCloud part');
});

test('a file whose name is used by most files links nothing through that name', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `App/F${i}.swift`, lang: 'swift', imports: [],
    swift: { decls: i === 0 ? [{ name: 'Theme', kind: 'struct' }] : i === 1 ? [{ name: 'Rare', kind: 'struct' }] : [], extended: [], refs: new Set(i > 1 ? ['Theme', ...(i === 2 ? ['Rare'] : [])] : []), locals: new Set() },
  }));
  const r = swiftLinks(root, files, files.map((f) => f.path));
  assert.deepEqual(r.dropped, ['Theme'], 'used by 10 of 12 files: over 40%');
  assert.deepEqual(r.edges.map((e) => `${e.from} -> ${e.to}`), ['App/F2.swift -> App/F1.swift']);
});

test('a function name a file binds itself (a parameter) is not a use of a top-level function elsewhere', () => {
  const a = extract('func routes(_ app: Application) throws {}\n', 'swift', 'A.swift');
  const b = extract('struct C { func boot(routes: RoutesBuilder) { routes.get("x") } }\n', 'swift', 'B.swift');
  const files = [{ path: 'Sources/App/A.swift', lang: 'swift', ...a }, { path: 'Sources/App/B.swift', lang: 'swift', ...b }];
  assert.deepEqual(swiftLinks(root, files, files.map((f) => f.path)).edges, []);
});

test('doc comments describe files: ///, a /** */ block, a // header, and Xcode’s template header is skipped', () => {
  const doc = (p) => graph.files.find((f) => f.p === p).doc;
  assert.equal(doc('Packages/Kit/Sources/KitCore/Cart.swift'), 'The basket a shopper fills before paying.', 'template header skipped, then the first type’s ///');
  assert.equal(doc('Packages/Kit/Sources/KitCore/PriceList.swift'), "Prices for every product, in cents, fetched from the shop's price service.");
  assert.equal(doc('App/ShopApp.swift'), "The app's front door: opens the cart screen and keeps the shopper's iCloud copy in step.");
  const cart = graph.files.find((f) => f.p === 'Packages/Kit/Sources/KitCore/Cart.swift');
  assert.deepEqual(cart.s.map((s) => `${s[0]} ${s[1]}`), ['Cart struct', 'Line struct', 'cartTotal function'], 'private Scratch stays out; public nested Line is in');
  assert.equal(cart.s.find((s) => s[0] === 'cartTotal')[4], 'Adds up a cart in cents.');
});

test('Swift URL(string:) and URLRequest calls reach outside services; interpolated paths are calls', () => {
  assert.ok(scan.hosts.some((h) => h.from.endsWith('PriceList.swift') && h.host === 'prices.example-shop.com'));
  const r = extract('let u = URL(string: "\\(base)/v1/items/\\(id)")!\nvar req = URLRequest(url: u)\nreq.httpMethod = "POST"\nlet x = URL(string: "http://127.0.0.1:\\(port)/mcp")', 'swift', 'Api.swift');
  assert.deepEqual(r.calls.map((c) => c.path), ['/v1/items/${x}']);
  assert.deepEqual(r.hosts, [], 'a local address with an interpolated port is not an outside service');
});

test('XcodeGen, Package.swift and Xcode project parsing on their own', () => {
  const yml = parseXcodeGen('targets:\n  App:\n    type: application\n    sources:\n      - path: Sources/App\n        excludes: ["*.plist"]\n      - Shared\n    dependencies:\n      - target: Widgets\n      - package: Core\n  AppTests:\n    type: bundle.unit-test\n    sources: [Tests]\n', 'ios');
  assert.deepEqual(yml.modules.map((m) => [m.name, m.dirs, m.deps, m.test]), [['App', ['ios/Sources/App', 'ios/Shared'], ['Widgets', 'Core'], false], ['AppTests', ['ios/Tests'], [], true]]);
  const pkg = parsePackageSwift('let p = Package(name: "X", targets: [.target(name: "A", path: "Code/A"), .executableTarget(name: "B", dependencies: ["A", .product(name: "NIO", package: "swift-nio")])])', 'pkg');
  assert.deepEqual(pkg.modules.map((m) => [m.name, m.dirs[0], m.deps]), [['A', 'pkg/Code/A', []], ['B', 'pkg/Sources/B', ['A', 'NIO']]]);
  const pbx = [
    '\t\tAA /* App */ = {', '\t\t\tisa = PBXFileSystemSynchronizedRootGroup;', '\t\t\tpath = App;', '\t\t};',
    '\t\tBB /* Shop */ = {', '\t\t\tisa = PBXNativeTarget;', '\t\t\tfileSystemSynchronizedGroups = (', '\t\t\t\tAA /* App */,', '\t\t\t);', '\t\t\tname = Shop;', '\t\t};',
    '\t\tCC /* Widgets */ = {', '\t\t\tisa = PBXNativeTarget;', '\t\t\tname = Widgets;', '\t\t};',
  ].join('\n');
  assert.deepEqual(parsePbxproj(pbx, '', (d) => d === 'Widgets').modules.map((m) => [m.name, m.dirs]), [['Shop', ['App']], ['Widgets', ['Widgets']]]);
});

test('an Xcode project without a manifest still gives its targets as modules', () => {
  const pbx = [
    '\t\tBB /* Notes */ = {', '\t\t\tisa = PBXNativeTarget;', '\t\t\tname = Notes;', '\t\t};',
  ].join('\n');
  const r = makeProject({ 'Notes.xcodeproj/project.pbxproj': pbx, 'Notes/NotesApp.swift': 'import SwiftUI\n/// The app.\n@main struct NotesApp: App { var body: some Scene { WindowGroup { NoteList() } } }\n', 'Notes/NoteList.swift': 'import SwiftUI\n/// The list.\nstruct NoteList: View { var body: some View { Text("hi") } }\n' });
  try {
    run('scan.mjs', r);
    const s = readJson(path.join(r, 'floorplan', '.cache', 'scan.json'));
    assert.deepEqual(s.files.filter((f) => f.module).map((f) => f.module), ['Notes', 'Notes']);
    assert.deepEqual(s.edges.map((e) => `${e.from} -> ${e.to}`), ['Notes/NotesApp.swift -> Notes/NoteList.swift']);
  } finally { cleanup(r); }
});
