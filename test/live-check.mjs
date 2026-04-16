// One-shot: verify remember → recall against the REAL user DB (~/.linksee-memory/memory.db).
// Simulates exactly what Claude Code would do after MCP registration.

import { spawn } from 'node:child_process';

const server = spawn('node', ['dist/mcp/server.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  // note: NO LINKSEE_MEMORY_DIR override → uses default ~/.linksee-memory/memory.db
});

let buf = '';
const pending = new Map();
let nextId = 1;

server.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg); }
    } catch {}
  }
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }}, 5000);
  });
}

const parse = (r) => JSON.parse(r.result.content[0].text);

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'live-check', version: '1.0' },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  console.log('=== mcp__linksee__remember ===');
  const rem = await rpc('tools/call', {
    name: 'remember',
    arguments: {
      entity_name: 'テスト',
      entity_kind: 'concept',
      layer: 'goal',
      content: '登録確認',
    },
  });
  console.log(JSON.stringify(parse(rem), null, 2));

  console.log('\n=== mcp__linksee__recall (query="テスト") ===');
  const rec = await rpc('tools/call', {
    name: 'recall',
    arguments: { query: 'テスト' },
  });
  console.log(JSON.stringify(parse(rec), null, 2));

  await new Promise((resolve) => { server.once('exit', () => resolve()); server.kill(); });
}

main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
