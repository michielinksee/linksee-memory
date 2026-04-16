// Day 3 smoke: read_smart with chunking + diff cache.
// Covers: first_read / unchanged / modified / unchanged_content / forced_full
// File types exercised: .ts (AST), .py (indent), .md (headings), fallback

import { spawn } from 'node:child_process';
import { rmSync, existsSync, writeFileSync, utimesSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const DB_DIR = join(homedir(), '.linksee-memory-test-rs');
process.env.LINKSEE_MEMORY_DIR = DB_DIR;
if (existsSync(DB_DIR)) rmSync(DB_DIR, { recursive: true, force: true });

const WORK = join(tmpdir(), `linksee-rs-${Date.now()}`);
mkdirSync(WORK, { recursive: true });

const server = spawn('node', ['dist/mcp/server.js'], {
  env: { ...process.env, LINKSEE_MEMORY_DIR: DB_DIR },
  stdio: ['pipe', 'pipe', 'inherit'],
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
    } catch { /* ignore */ }
  }
});

function rpc(method, params) {
  const id = nextId++;
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); }
    }, 10000);
  });
}

const parse = (r) => JSON.parse(r.result.content[0].text);
const readSmart = (path, force = false) =>
  rpc('tools/call', { name: 'read_smart', arguments: { path, force } }).then(parse);

function assert(cond, msg) {
  if (!cond) { console.error(`❌ FAIL: ${msg}`); server.kill(); process.exit(1); }
  console.log(`✓ ${msg}`);
}

// Bump mtime using a monotonic base + tick (handles writeFileSync resetting mtime
// to wall-clock, which would otherwise collide with prior bumps when calls land
// within the same filesystem resolution second).
const BASE_MTIME = Math.floor(Date.now() / 1000);
let mtimeTick = 0;
async function bumpMtime(path) {
  mtimeTick += 1000;
  const t = BASE_MTIME + mtimeTick;
  utimesSync(path, t, t);
}

async function run() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-rs', version: '1.0' },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // ========== .ts file: AST chunking ==========
  const tsPath = join(WORK, 'sample.ts');
  const v1 = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function greet(name: string): string {
  return \`hello, \${name}\`;
}

export function farewell(name: string): string {
  return \`goodbye, \${name}\`;
}

export class Counter {
  private n = 0;
  inc() { this.n++; return this.n; }
}
`;
  writeFileSync(tsPath, v1);
  await new Promise(r => setTimeout(r, 50));

  // 1. first_read
  const r1 = await readSmart(tsPath);
  assert(r1.status === 'first_read', `first_read on new .ts file (got ${r1.status})`);
  assert(r1.content === v1, 'first_read returns full content');
  assert(r1.chunks.length >= 4, `chunked into >=4 (imports/greet/farewell/Counter): got ${r1.chunks.length}`);
  const chunkIds = r1.chunks.map(c => c.id);
  assert(chunkIds.includes('function:greet'), 'chunk id "function:greet" present');
  assert(chunkIds.includes('function:farewell'), 'chunk id "function:farewell" present');
  assert(chunkIds.includes('class:Counter'), 'chunk id "class:Counter" present');
  assert(chunkIds.includes('import:_block'), 'imports grouped into import:_block');

  // 2. unchanged (same mtime)
  const r2 = await readSmart(tsPath);
  assert(r2.status === 'unchanged', `second read returns unchanged (got ${r2.status})`);
  assert(r2.tokens_saved > 0, `tokens_saved reported: ${r2.tokens_saved}`);
  assert(!('content' in r2), 'unchanged response omits content');
  assert(r2.chunks.length === r1.chunks.length, 'unchanged returns chunk metadata');

  // 3. modify ONE function → diff should return only that chunk
  const v2 = v1.replace(
    'return `hello, ${name}`;',
    'return `HELLO, ${name.toUpperCase()}`;  // louder'
  );
  writeFileSync(tsPath, v2);
  await bumpMtime(tsPath);

  const r3 = await readSmart(tsPath);
  assert(r3.status === 'modified', `modify triggers "modified" status (got ${r3.status})`);
  assert(r3.changed_chunks.length === 1, `exactly 1 chunk changed (got ${r3.changed_chunks.length})`);
  assert(r3.changed_chunks[0].id === 'function:greet', `the changed chunk is function:greet (got ${r3.changed_chunks[0].id})`);
  assert(r3.changed_chunks[0].status === 'modified', 'chunk status is modified');
  assert(r3.unchanged_chunks.length >= 3, `>=3 unchanged chunks preserved (got ${r3.unchanged_chunks.length})`);
  // On tiny files the envelope can eat the savings — verified separately on realistic-size file below.
  assert(r3.summary.tokens_saved >= 0 && r3.summary.tokens_returned > 0, `tiny-file diff accounting ok (saved=${r3.summary.tokens_saved}, returned=${r3.summary.tokens_returned})`);

  // 4. touch without content change → unchanged_content
  await bumpMtime(tsPath);
  const r4 = await readSmart(tsPath);
  assert(r4.status === 'unchanged_content', `touch-only change → unchanged_content (got ${r4.status})`);

  // 5. force → forced_full
  const r5 = await readSmart(tsPath, true);
  assert(r5.status === 'forced_full', `force:true returns forced_full (got ${r5.status})`);
  assert(r5.content === v2, 'forced_full returns current full content');

  // 6. add a new function → "added" chunk
  const v3 = v2 + `
export function newFn(): number {
  return 42;
}
`;
  writeFileSync(tsPath, v3);
  await bumpMtime(tsPath);
  const r6 = await readSmart(tsPath);
  assert(r6.status === 'modified', 'adding a function triggers modified');
  const added = r6.changed_chunks.find((c) => c.id === 'function:newFn');
  assert(added && added.status === 'added', `new function detected as "added" (got ${added?.status})`);

  // 7. remove a function → "removed_chunks"
  const farewellStart = v3.indexOf('export function farewell');
  const farewellEnd = v3.indexOf('\n}\n', farewellStart) + 3;
  assert(farewellStart >= 0 && farewellEnd > farewellStart, 'test setup: farewell block located');
  const v4 = v3.slice(0, farewellStart) + v3.slice(farewellEnd);
  writeFileSync(tsPath, v4);
  await bumpMtime(tsPath);
  const r7 = await readSmart(tsPath);
  assert(r7.status === 'modified', `r7 status=${r7.status} (expected modified)`);
  const removed = r7.removed_chunks?.find((c) => c.id === 'function:farewell');
  assert(removed, `farewell removal detected in removed_chunks (got: ${JSON.stringify(r7.removed_chunks)})`);

  // ========== .md file: heading chunking ==========
  const mdPath = join(WORK, 'doc.md');
  const md1 = `# Top title

Intro paragraph.

## Section A

Body of A.

## Section B

Body of B.

### Sub of B

More.
`;
  writeFileSync(mdPath, md1);
  await new Promise(r => setTimeout(r, 50));

  const rmd1 = await readSmart(mdPath);
  assert(rmd1.status === 'first_read', 'md first_read');
  const mdIds = rmd1.chunks.map((c) => c.id);
  assert(mdIds.includes('heading:Section A'), `md chunk "heading:Section A" present`);
  assert(mdIds.includes('heading:Section B'), `md chunk "heading:Section B" present`);
  assert(mdIds.includes('heading:Sub of B'), `md chunk "heading:Sub of B" present`);

  // Modify only Section B
  const md2 = md1.replace('Body of B.', 'Body of B — UPDATED.');
  writeFileSync(mdPath, md2);
  await bumpMtime(mdPath);
  const rmd2 = await readSmart(mdPath);
  assert(rmd2.status === 'modified', 'md modified');
  const changedB = rmd2.changed_chunks.find((c) => c.id === 'heading:Section B');
  assert(changedB, 'md Section B detected as changed');
  assert(!rmd2.changed_chunks.find((c) => c.id === 'heading:Section A'), 'md Section A NOT in changed chunks');

  // ========== .py file: indent chunking ==========
  const pyPath = join(WORK, 'sample.py');
  const py1 = `import os
import sys

def alpha(x):
    return x + 1

def beta(y):
    return y * 2

class Gamma:
    def method(self):
        return 0
`;
  writeFileSync(pyPath, py1);
  await new Promise(r => setTimeout(r, 50));

  const rpy1 = await readSmart(pyPath);
  assert(rpy1.status === 'first_read', 'py first_read');
  const pyIds = rpy1.chunks.map((c) => c.id);
  assert(pyIds.includes('python_def:alpha'), `py chunk "python_def:alpha" present`);
  assert(pyIds.includes('python_def:beta'), `py chunk "python_def:beta" present`);
  assert(pyIds.includes('python_class:Gamma'), `py chunk "python_class:Gamma" present`);

  // Modify alpha only
  const py2 = py1.replace('return x + 1', 'return x + 100');
  writeFileSync(pyPath, py2);
  await bumpMtime(pyPath);
  const rpy2 = await readSmart(pyPath);
  assert(rpy2.status === 'modified', 'py modified');
  assert(rpy2.changed_chunks.length === 1 && rpy2.changed_chunks[0].id === 'python_def:alpha', `only alpha changed`);

  // ========== REALISTIC FILE: measure real token savings ==========
  // Build a 300-line .ts file with 10 functions, modify 1, expect big savings.
  const bigPath = join(WORK, 'big.ts');
  const buildBigFile = (modifyFnIdx = -1) => {
    const imports = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
`;
    const fns = [];
    for (let i = 0; i < 10; i++) {
      const body = i === modifyFnIdx
        ? `  // MODIFIED BODY ${i}\n  const salt = '${i}-changed';\n  return salt + Math.random().toString(36);`
        : `  const buffer = Buffer.from(\`process-\${input}-${i}\`);\n  const hash = createHash('sha256').update(buffer).digest('hex');\n  return hash.slice(0, 16);`;
      fns.push(`export function processor${i}(input: string): string {
  // A deliberately realistic function body with multiple statements,
  // comments, error handling patterns, and a bit of verbosity to simulate
  // real-world code density. This helps the diff cache prove its worth.
  if (!input || input.length === 0) {
    throw new Error('processor${i}: empty input');
  }
${body}
}`);
    }
    return imports + '\n' + fns.join('\n\n') + '\n';
  };

  const big1 = buildBigFile(-1);
  writeFileSync(bigPath, big1);
  await new Promise(r => setTimeout(r, 50));

  const rbig1 = await readSmart(bigPath);
  assert(rbig1.status === 'first_read', 'big-file first read');
  assert(rbig1.chunks.length >= 11, `big file chunks: ${rbig1.chunks.length} (>=11 with imports + 10 fns)`);
  const fullTokenBudget = rbig1.tokens_approx;

  // Modify only one function (index 5)
  const big2 = buildBigFile(5);
  writeFileSync(bigPath, big2);
  await bumpMtime(bigPath);
  const rbig2 = await readSmart(bigPath);

  assert(rbig2.status === 'modified', 'big-file modified');
  assert(rbig2.changed_chunks.length === 1, `only 1 of 10 fns changed (got ${rbig2.changed_chunks.length})`);
  assert(rbig2.changed_chunks[0].id === 'function:processor5', `the changed fn is processor5`);
  assert(rbig2.summary.tokens_saved > 0, `real token savings on realistic file: ${rbig2.summary.tokens_saved} / ${rbig2.summary.tokens_full}`);
  assert(rbig2.summary.pct_saved >= 60, `>=60% token savings on 1-of-10 change (got ${rbig2.summary.pct_saved}%)`);
  console.log(`\n📊 Real-world token savings:`);
  console.log(`    full file:     ${rbig2.summary.tokens_full} tokens`);
  console.log(`    diff returned: ${rbig2.summary.tokens_returned} tokens`);
  console.log(`    saved:         ${rbig2.summary.tokens_saved} tokens (${rbig2.summary.pct_saved}%)`);

  // Unchanged re-read of the big file → near-zero tokens
  const rbig3 = await readSmart(bigPath);
  assert(rbig3.status === 'unchanged', 'big-file unchanged on re-read');
  const unchangedSavingsPct = Math.round((rbig3.tokens_saved / fullTokenBudget) * 100);
  console.log(`    unchanged re-read saves: ${rbig3.tokens_saved} tokens (~${unchangedSavingsPct}% of full read)`);

  // ========== non-existent file ==========
  const rne = await readSmart(join(WORK, 'does-not-exist.txt'));
  assert(rne.ok === false && /not found/i.test(rne.error), 'missing file returns not-found error');

  // Wait for server to fully release the SQLite file before cleanup (Windows).
  await new Promise((resolve) => {
    server.once('exit', () => resolve());
    server.kill();
  });
  await new Promise((r) => setTimeout(r, 300));

  try {
    rmSync(WORK, { recursive: true, force: true });
    rmSync(DB_DIR, { recursive: true, force: true });
  } catch (e) {
    console.warn(`(cleanup warning: ${e.message})`);
  }

  console.log('\n🎉 Day 3 smoke test complete — read_smart fully verified');
}

run().catch((e) => {
  console.error('❌ smoke failed:', e);
  server.kill();
  process.exit(1);
});
