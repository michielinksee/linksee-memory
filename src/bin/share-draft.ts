#!/usr/bin/env node
// linksee-memory share-draft — print a link to KanseiLINK's reviewed draft page for a field note.
// Same checks and the same builder as the MCP tool `share_draft` (src/lib/share-draft.ts).
// Makes no network call and writes nothing: it prints a URL, and you open it yourself.
//
//   npx -y linksee-memory share-draft --help
//   npx -y linksee-memory share-draft --service freee --task "..." --symptom "..." \
//     --tried "..." --result "..." --kind execution [--conditions "..."] [--runtime claude] [--json]

import { buildShareDraft, ALLOWED_KEYS, KINDS, RUNTIMES, NOTICE, NOTICE_EN, DRAFT_PAGE, URL_MAX } from '../lib/share-draft.js';

const HELP = `linksee-memory share-draft — make a link to a reviewed draft of a fix, for other agents

Linksee sends nothing. This prints a URL to ${DRAFT_PAGE}
The page opens with the fields filled; you read them there, and only your click sends.
If you never run this (or the MCP tool share_draft), nothing happens.

Usage:
  npx -y linksee-memory share-draft --service <id> --task <text> --symptom <text> \\
    --tried <text> --result <text> --kind <${KINDS.join('|')}> \\
    [--conditions <text>] [--runtime <${RUNTIMES.join('|')}>] [--json]

Fields (nothing else is accepted):
  --service     KanseiLINK service_id, lowercase: ^[a-z0-9_.-]{1,160}$   (required)
  --task        what you were trying to do, ≤300 chars                     (required)
  --symptom     the KIND of error, no values, ≤600 chars                   (required)
  --tried       steps you tried, ≤2,000 chars                              (required)
  --result      how it was solved / that it was not, ≤1,000 chars          (required)
  --conditions  tool + version, kind of environment, ≤600 chars
  --kind        execution | documentation | hypothesis                     (required)
  --runtime     claude | codex | gpt | gemini | other

Stops (no link) when a field looks like a token / API key / JWT / Bearer value, an e-mail,
a tenant URL (acme.slack.com …), an IP address, a local path (C:\\, /Users/, /home/), or a
long hex / base64 run (32+), and says which field. The whole URL must be ≤${URL_MAX} chars
(one Japanese character takes 9) — it asks you to shorten; it never cuts.

${NOTICE[0]}
${NOTICE[1]}
`;

function parse(argv: string[]): { fields: Record<string, string>; json: boolean; help: boolean; bad: string[] } {
  const fields: Record<string, string> = {};
  const bad: string[] = [];
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { help = true; continue; }
    if (a === '--json') { json = true; continue; }
    const m = /^--([a-z_]+)(?:=(.*))?$/s.exec(a);
    if (!m) { bad.push(a); continue; }
    const key = m[1];
    const value = m[2] ?? argv[++i];
    if (value === undefined) { bad.push(a); continue; }
    fields[key] = value; // unknown keys are reported by the builder
  }
  return { fields, json, help, bad };
}

const { fields, json, help, bad } = parse(process.argv.slice(2));
if (help || (Object.keys(fields).length === 0 && bad.length === 0)) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (bad.length) {
  process.stderr.write(`Could not read: ${bad.join(' ')}\nFields: ${ALLOWED_KEYS.map((k) => '--' + k).join(' ')}\n`);
  process.exit(2);
}

const r = buildShareDraft(fields);
if (json) {
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exit(r.ok ? 0 : 1);
}
if (!r.ok) {
  process.stderr.write('No link made.\n');
  for (const p of r.problems) process.stderr.write(`  ${p.field}: ${p.reason}\n`);
  process.exit(1);
}
process.stdout.write(`${r.url}\n\n${NOTICE[0]}\n${NOTICE[1]}\n${NOTICE_EN[0]}\n${NOTICE_EN[1]}\n`);
