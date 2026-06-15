// Build an asciinema .cast from the REAL demo command output (no fakery).
// Then render to GIF:  agg where-demo.cast where-demo.gif
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bin = join(here, '..', 'dist', 'bin', 'map-import.js');

const steps = ['where README.md', 'explain readme', 'status'];
const readPause = { 'where README.md': 2.6, 'explain readme': 4.2, status: 3.0 };

const PROMPT = '\x1b[38;5;42m$\x1b[0m ';      // green prompt
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';          // clear screen + scrollback, cursor home
const typeDelay = 0.045;

const events = [];
let t = 0.4;
const at = (dt, data) => { t = +(t + dt).toFixed(3); events.push([t, 'o', data]); };

at(0, CLEAR + PROMPT);
steps.forEach((cmd, i) => {
  const full = `linksee-memory-map ${cmd}`;
  for (const ch of full) at(typeDelay, ch);     // type the command
  at(0.45, '\r\n');                              // press enter
  let out = execSync(`node "${bin}" ${cmd}`, { cwd: here, encoding: 'utf8' });
  out = out.replace(/\s+$/,'').replace(/\n/g, '\r\n');
  at(0.25, out + '\r\n');                         // reveal real output
  at(readPause[cmd], '');                         // pause to read
  if (i < steps.length - 1) at(0.4, CLEAR + PROMPT); // fresh screen for next command
});
at(1.6, '');                                      // hold the last frame

const header = { version: 2, width: 96, height: 30, timestamp: 1718200000, env: { TERM: 'xterm-256color', SHELL: '/bin/bash' }, title: 'linksee-memory-map' };
const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))];
writeFileSync(join(here, 'where-demo.cast'), lines.join('\n') + '\n');
console.log(`wrote where-demo.cast (${events.length} events, ~${Math.round(t)}s)`);
