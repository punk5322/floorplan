// Health's secret check: it finds keys and passwords written into code, records only where they are
// and a masked hint, and never keeps the value itself. Secret-looking test values are assembled at
// runtime so none is ever committed to this repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib, FAKE_PASSWORD } from './helpers.mjs';

const { findIssues } = await lib('health.mjs');
const secrets = (src, path = 'app/config.py', lang = 'python') => findIssues(src, { path, category: 'code', lang }).filter((x) => x.k === 'secret');
const FAKE_GITHUB_TOKEN = 'ghp_' + 'aBcD' + '1e2F3g4H5i6J7k8L9m0N1o2P3q4R5s6T7u8V';

test('a hard-coded password is found, with its line, and masked', () => {
  const [s, ...rest] = secrets(`PORT = 3000\nDB_PASSWORD = "${FAKE_PASSWORD}"\n`);
  assert.equal(rest.length, 0);
  assert.equal(s.line, 2);
  assert.equal(s.name, 'DB_PASSWORD');
  assert.equal(s.sev, 'high');
  assert.equal(s.hint, `${FAKE_PASSWORD.length} characters`, 'a password hint gives only its length');
});

test('a known key format is named after its service and shows only its first characters', () => {
  const [s] = secrets(`token = "${FAKE_GITHUB_TOKEN}"`);
  assert.equal(s.svc, 'GitHub');
  assert.match(s.hint, /^starts “ghp_…”, \d+ characters$/);
});

test('the secret value never appears in what Health records', () => {
  for (const found of [secrets(`DB_PASSWORD = "${FAKE_PASSWORD}"`), secrets(`token = "${FAKE_GITHUB_TOKEN}"`)]) {
    const text = JSON.stringify(found);
    assert.ok(!text.includes(FAKE_PASSWORD) && !text.includes(FAKE_GITHUB_TOKEN.slice(4)), text);
  }
});

test('placeholders, values read from the environment and public settings are not flagged', () => {
  assert.deepEqual(secrets('DB_PASSWORD = "changeme"\nAPI_KEY = "your-api-key-here"\nSECRET = "xxx"\n'), []);
  assert.deepEqual(secrets('DB_PASSWORD = os.environ["DB_PASSWORD"]\nAPI_KEY = os.getenv("API_KEY")\n'), []);
  assert.deepEqual(secrets('API_URL = "https://api.example.com/v1/orders"\n'), []);
});

test('Swift: Keychain item labels and a choice between two label strings are not secrets; a real key still is', () => {
  const swift = (src) => secrets(src, 'App/AgentServer.swift', 'swift');
  // Household's AgentServer.swift: the account name each person's password is stored under
  assert.deepEqual(swift('let account = person == .arsh ? "agent-password" : "agent-password-milo"\n'), []);
  assert.deepEqual(swift('Keychain.save(token, service: "shop-password-store", account: "refresh-token-1")\n'), []);
  assert.deepEqual(swift('query[kSecAttrAccount as String] = "api_token_main"\n'), []);
  const real = 'a8F3kQ2' + 'zL9xW4mR7tY1';
  assert.equal(swift(`let clientSecret = "${real}"\n`).length, 1, 'a hard-coded secret in Swift is still found');
  assert.equal(swift(`let k = "${FAKE_GITHUB_TOKEN}" // Keychain.save\n`).length, 1, 'a known key format is found even on a Keychain line');
});

test('tokens that are public by design are not flagged (#23)', () => {
  const hex = [...Array(32)].map((_, i) => '01234567890abcdef'[(i * 7 + 3) % 16]).join('');
  // Cloudflare Web Analytics' beacon token has to be in the page for analytics to work
  const beacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${hex}"}'></script>`;
  assert.deepEqual(secrets(beacon, 'site/index.html', 'html'), []);
  // the same value under a secret-sounding name elsewhere is still flagged
  assert.equal(secrets(`ACCESS_TOKEN = "${hex}"`).length, 1);
  // a Mapbox public token
  assert.deepEqual(secrets(`mapboxToken = "pk.${'eyJ1IjoiZXhhbXBsZSIsImEiOiJ'}${hex}.${hex.slice(0, 22)}"`, 'web/map.ts', 'typescript'), []);
});
