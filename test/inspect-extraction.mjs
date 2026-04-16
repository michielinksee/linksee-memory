// Spot-check: show extracted memories for a specific session (no DB writes).
// Usage: node test/inspect-extraction.mjs <session-uuid-prefix>

import { parseSessionFile, projectNameFromCwd } from '../dist/lib/session-parser.js';
import { extractSession } from '../dist/lib/session-extractor.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const prefix = process.argv[2];
if (!prefix) { console.error('Usage: inspect-extraction.mjs <session-uuid-prefix>'); process.exit(1); }

const projectDir = join(homedir(), '.claude', 'projects', 'C--Users-HP-Card-Navi');
const files = readdirSync(projectDir).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'));
if (files.length === 0) { console.error('no match for', prefix); process.exit(1); }

const f = join(projectDir, files[0]);
const parsed = parseSessionFile(f);
if (!parsed) { console.error('parse failed'); process.exit(1); }

const result = extractSession(parsed, projectNameFromCwd(parsed.project_cwd));

console.log(`=== Session ${parsed.session_id} ===`);
console.log(`Project: ${result.project_name}, cwd: ${parsed.project_cwd}`);
console.log(`Branch: ${parsed.git_branch}`);
console.log(`Duration: ${Math.round((parsed.ended_at - parsed.started_at) / 60)} min`);
console.log(`Turns: ${parsed.turn_count_user} user / ${parsed.turn_count_assistant} assistant, ${parsed.errors_count} errors`);
console.log(`Extracted: ${result.memories.length} memories, ${result.file_edits.length} file edits\n`);

const byLayer = {};
for (const m of result.memories) {
  byLayer[m.layer] = byLayer[m.layer] || [];
  byLayer[m.layer].push(m);
}

for (const [layer, mems] of Object.entries(byLayer)) {
  console.log(`\n---- ${layer.toUpperCase()} (${mems.length}) ----`);
  mems.slice(0, 5).forEach((m, i) => {
    let preview;
    try {
      const obj = JSON.parse(m.content);
      preview = JSON.stringify(obj, null, 2).slice(0, 500);
    } catch { preview = m.content.slice(0, 400); }
    console.log(`\n[${i + 1}] importance=${m.importance}, kind=${m.source.kind}`);
    console.log(preview);
  });
  if (mems.length > 5) console.log(`\n... and ${mems.length - 5} more`);
}

console.log(`\n\n---- SAMPLE FILE_EDITS (up to 5) ----`);
result.file_edits.slice(0, 5).forEach((fe, i) => {
  console.log(`\n[${i + 1}] ${fe.operation} ${fe.file_path}`);
  console.log(`  turn_uuid: ${fe.turn_uuid?.slice(0, 8) ?? '?'}`);
  console.log(`  when: ${new Date(fe.occurred_at * 1000).toISOString()}`);
  console.log(`  context: "${fe.context_snippet.slice(0, 200)}"`);
});
