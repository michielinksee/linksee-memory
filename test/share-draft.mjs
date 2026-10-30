#!/usr/bin/env node
// share_draft: fields → link, secrets → no link, and the server records only the fact.
// No network: the builder is pure, and the server is driven over stdio.
//
// Run: pnpm run build && node test/share-draft.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildShareDraft, findSecretShapes, DRAFT_PAGE, URL_MAX } from '../dist/lib/share-draft.js';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); failures++; }
};

const GOOD = {
  service: 'freee',
  task: '請求書の一覧を取る',
  symptom: '401 invalid_token（アクセストークンの期限切れ）',
  tried: 'refresh token で取り直した。会社 ID を付け直した。',
  result: '取り直した後は 200 で返った',
  conditions: 'freee-mcp 0.9・Windows・Claude Code',
  kind: 'execution',
  runtime: 'claude',
};

console.log('share_draft — builder');
{
  const r = buildShareDraft(GOOD);
  check('good input makes a link', r.ok === true, JSON.stringify(r).slice(0, 200));
  const u = new URL(r.url);
  check('link goes to the draft page', `${u.origin}${u.pathname}` === DRAFT_PAGE, r.url.slice(0, 80));
  const keys = [...u.searchParams.keys()];
  check('query keys are exactly the page fields', JSON.stringify(keys) === JSON.stringify(['service', 'task', 'symptom', 'tried', 'result', 'conditions', 'kind', 'runtime']), keys.join(','));
  check('values round-trip', Object.entries(GOOD).every(([k, v]) => u.searchParams.get(k) === v));
  check('URL ≤ 2,000', r.url.length <= URL_MAX && r.length === r.url.length);
  check('two notices returned', Array.isArray(r.notice) && r.notice.length === 2 && /確認してから送られます/.test(r.notice[0]) && /Cloudflare/.test(r.notice[1]));

  const noOpt = buildShareDraft({ ...GOOD, conditions: undefined, runtime: undefined });
  check('optional conditions/runtime may be left out', noOpt.ok === true && !new URL(noOpt.url).searchParams.has('conditions') && !new URL(noOpt.url).searchParams.has('runtime'));
}

// Each secret shape, one at a time, in a different field — none may produce a link.
const SECRETS = [
  ['symptom', 'sk- key', 'sk-proj-AbCdEf123456789'],
  ['symptom', 'sk-ant key', 'sk-ant-api03-abcdefgh12345'],
  ['tried', 'ghp_ token', 'ghp_abcdefGHIJ1234567890'],
  ['tried', 'github_pat_', 'github_pat_11ABCDEFG0123456789'],
  ['result', 'Slack xoxb-', 'xoxb-1234567890-abcdefghij'],
  ['result', 'AWS AKIA', 'AKIAIOSFODNN7EXAMPLE'],
  ['conditions', 'Google AIza', 'AIzaSyA-abcdefghijklmnopqrstu'],
  ['symptom', 'Bearer value', 'Authorization: Bearer abc123def456'],
  ['symptom', 'JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
  ['tried', 'key=value secret', 'client_secret=s3cr3tvalue'],
  ['task', 'e-mail', 'ops@example.co.jp に通知を送る'],
  ['tried', 'tenant URL', 'https://acme.slack.com/api/chat.postMessage を叩いた'],
  ['tried', 'bare tenant host', 'acme.kintone.com のアプリ 12'],
  ['conditions', 'IPv4', '192.168.10.24 から接続'],
  ['conditions', 'IPv6', 'fe80::1ff:fe23:4567:890a から'],
  ['conditions', 'Windows path', 'C:\\Users\\taro\\project\\.env を読んだ'],
  ['conditions', 'Windows path (forward)', 'C:/work/app で実行'],
  ['conditions', '/Users/ path', '/Users/taro/app で実行'],
  ['conditions', '/home/ path', '/home/ubuntu/app で実行'],
  ['symptom', 'UUID', 'request id 123e4567-e89b-12d3-a456-426614174000'],
  ['symptom', 'long hex', 'session 0123456789abcdef0123456789abcdef'],
  ['result', 'long base64', 'dGhpc2lzYXZlcnlsb25nc2VjcmV0dmFsdWUxMjM0NTY='],
];
console.log('share_draft — every secret shape stops the build');
for (const [field, label, text] of SECRETS) {
  const r = buildShareDraft({ ...GOOD, [field]: text });
  const named = r.ok === false && r.problems.some((p) => p.field === field && Array.isArray(p.kinds) && p.kinds.length > 0);
  check(`${label} in ${field} → no link, field named`, named && !('url' in r), JSON.stringify(r).slice(0, 160));
}
{
  const r = buildShareDraft({ ...GOOD, service: 'acme.slack.com' });
  check('service that is a tenant host → no link', r.ok === false && r.problems.some((p) => p.field === 'service'));
}

console.log('share_draft — ordinary text passes (no false stops)');
for (const t of [
  '401 invalid_token が返った',
  'token authentication failed',
  'PERMISSION_DENIED_INSUFFICIENT_AUTHENTICATION_SCOPES',
  'https://developer.freee.co.jp/reference/accounting を読んだ',
  'api.slack.com の chat.postMessage',
  'Node 20.11.1・freee-mcp 0.9.3',
  'http://localhost:3000 で試した',
  '10:30:45 に 429',
]) {
  check(`passes: ${t}`, findSecretShapes(t).length === 0, JSON.stringify(findSecretShapes(t)));
}

console.log('share_draft — limits and vocabularies');
{
  const long = buildShareDraft({ ...GOOD, tried: 'あ'.repeat(2000) });
  check('over 2,000 URL chars → asks to shorten, no link', long.ok === false && /短くしてください/.test(long.problems[0].reason) && !('url' in long), JSON.stringify(long).slice(0, 200));
  const fieldMax = buildShareDraft({ ...GOOD, task: 'a'.repeat(301) });
  check('task over 300 → stops on task', fieldMax.ok === false && fieldMax.problems.some((p) => p.field === 'task'));
  const badKind = buildShareDraft({ ...GOOD, kind: 'verified' });
  check('kind outside the vocabulary → stops', badKind.ok === false && badKind.problems.some((p) => p.field === 'kind'));
  const noKind = buildShareDraft({ ...GOOD, kind: undefined });
  check('kind is required', noKind.ok === false && noKind.problems.some((p) => p.field === 'kind'));
  const badRt = buildShareDraft({ ...GOOD, runtime: 'copilot' });
  check('runtime outside the vocabulary → stops', badRt.ok === false && badRt.problems.some((p) => p.field === 'runtime'));
  const extra = buildShareDraft({ ...GOOD, note: 'free text' });
  check('unknown field → stops', extra.ok === false && extra.problems.some((p) => p.field === 'note'));
  const badSvc = buildShareDraft({ ...GOOD, service: 'Freee Accounting' });
  check('service must be a lowercase id', badSvc.ok === false && badSvc.problems.some((p) => p.field === 'service'));
  const missing = buildShareDraft({ service: 'freee', kind: 'execution' });
  check('task/symptom/tried/result are required', missing.ok === false && ['task', 'symptom', 'tried', 'result'].every((f) => missing.problems.some((p) => p.field === f)));
}

console.log('share_draft — CLI');
{
  const help = spawnSync(process.execPath, ['dist/mcp/server.js', 'share-draft', '--help'], { encoding: 'utf8' });
  check('share-draft --help prints usage + notice', help.status === 0 && /share-draft/.test(help.stdout) && /Cloudflare/.test(help.stdout), help.stderr.slice(0, 120));
  const args = Object.entries(GOOD).flatMap(([k, v]) => [`--${k}`, v]);
  const ok = spawnSync(process.execPath, ['dist/mcp/server.js', 'share-draft', ...args, '--json'], { encoding: 'utf8' });
  const parsed = (() => { try { return JSON.parse(ok.stdout); } catch { return null; } })();
  check('CLI builds the same URL as the MCP builder', ok.status === 0 && parsed?.url === buildShareDraft(GOOD).url, ok.stderr.slice(0, 120));
  const bad = spawnSync(process.execPath, ['dist/mcp/server.js', 'share-draft', ...args, '--symptom', 'Bearer abc123def456'], { encoding: 'utf8' });
  check('CLI refuses a secret, exit 1, no URL on stdout', bad.status === 1 && !/https:/.test(bad.stdout) && /symptom/.test(bad.stderr));
}

console.log('share_draft — over MCP');
const dir = mkdtempSync(join(tmpdir(), 'linksee-share-'));
try {
  const child = spawn(process.execPath, ['dist/mcp/server.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LINKSEE_MEMORY_DIR: dir, LINKSEE_TELEMETRY: 'off' },
  });
  child.stderr.on('data', () => {});
  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'roots/list' && m.id !== undefined) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { roots: [] } }) + '\n'); continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res, rej) => {
    const my = ++id;
    const t = setTimeout(() => { pending.delete(my); rej(new Error(`timeout: ${method}`)); }, 30000);
    pending.set(my, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: my, method, params }) + '\n');
  });
  const call = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list', {})).result.tools;
    const t = tools.find((x) => x.name === 'share_draft');
    check('tools/list shows share_draft', !!t);
    check('description says: only when the user wants to share', /ONLY when the user/.test(t?.description ?? ''));
    check('schema refuses extra fields', t?.inputSchema?.additionalProperties === false);
    const ok = await call('share_draft', GOOD);
    check('MCP call returns the link', ok.ok === true && ok.url === buildShareDraft(GOOD).url);
    const no = await call('share_draft', { ...GOOD, tried: 'curl -H "Authorization: Bearer abc123def456"' });
    check('MCP call with a secret returns the field, no link', no.ok === false && no.problems.some((p) => p.field === 'tried') && !('url' in no));
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
  }
  // The DB holds the fact only: one row for the one link made, nothing from the fields.
  process.env.LINKSEE_MEMORY_DIR = dir;
  const { openDb } = await import('../dist/db/migrate.js');
  const db = openDb();
  const rows = db.prepare(`SELECT entity_id, kind, payload FROM events WHERE kind = 'share_draft_created'`).all();
  check('one record for one link made (refusals leave none)', rows.length === 1, JSON.stringify(rows));
  check('the record holds no field text', rows.every((r) => r.entity_id === null && r.payload === null));
  const dump = JSON.stringify(db.prepare(`SELECT * FROM events`).all()) + JSON.stringify(db.prepare(`SELECT content FROM memories`).all());
  check('no field text anywhere in events/memories', !dump.includes('請求書の一覧') && !dump.includes('invalid_token'));
  db.close();
} catch (e) {
  console.log('  FAIL harness:', String(e)); failures++;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
