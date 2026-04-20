#!/usr/bin/env node
// install-skill: copies the bundled SKILL.md into ~/.claude/skills/linksee-memory/
// so Claude Code can auto-invoke linksee-memory based on user intent.
//
// Usage:
//   npx linksee-memory-install-skill           (safe — won't overwrite without --force)
//   npx linksee-memory-install-skill --force   (overwrite existing file)
//   npx linksee-memory-install-skill --dry-run (show what would happen)
//
// Why: installing the MCP server alone doesn't teach Claude Code WHEN to call
// recall/remember/read_smart/etc. The skill provides trigger phrases (EN:
// "before", "last time", "same error again"; JP: "前に", "また同じエラー";
// new task start, file edits, etc.) so the agent auto-fires
// without the user having to type "use linksee-memory".

import { mkdirSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const force = args.includes('--force') || args.includes('-f');
const dryRun = args.includes('--dry-run');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`linksee-memory-install-skill

Install the linksee-memory Claude Code skill into ~/.claude/skills/linksee-memory/.

Options:
  --force, -f    Overwrite an existing skill file
  --dry-run      Show what would happen without writing
  --help, -h     This message

After installation, ensure the MCP server is registered in Claude Code:
  claude mcp add -s user linksee -- npx -y linksee-memory

The skill expects tool names of the form mcp__linksee__*. If you register the
server under a different name (e.g. "linksee-memory"), edit the skill file
afterwards.`);
  process.exit(0);
}

// The bundled skill lives next to us in dist/skill/ after build
const __filename = fileURLToPath(import.meta.url);
const skillSrc = join(dirname(__filename), '..', 'skill', 'SKILL.md');

if (!existsSync(skillSrc)) {
  console.error(`[error] bundled skill not found at ${skillSrc}`);
  console.error('This is a packaging bug. Please file an issue at:');
  console.error('  https://github.com/michielinksee/linksee-memory/issues');
  process.exit(1);
}

const targetDir = join(homedir(), '.claude', 'skills', 'linksee-memory');
const targetFile = join(targetDir, 'SKILL.md');
const exists = existsSync(targetFile);

if (dryRun) {
  console.log('[dry-run] Would install skill:');
  console.log(`  source: ${skillSrc}`);
  console.log(`  target: ${targetFile}`);
  console.log(`  exists: ${exists ? 'yes (would NOT overwrite without --force)' : 'no'}`);
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

if (exists && !force) {
  try {
    const bundled = readFileSync(skillSrc, 'utf8');
    const installed = readFileSync(targetFile, 'utf8');
    if (bundled === installed) {
      console.log(`[ok] Skill already installed and up to date:`);
      console.log(`     ${targetFile}`);
      process.exit(0);
    }
  } catch {
    /* fall through */
  }
  console.log(`[skip] A skill already exists at ${targetFile}`);
  console.log('       The bundled version differs. To overwrite, run:');
  console.log('       linksee-memory-install-skill --force');
  process.exit(0);
}

copyFileSync(skillSrc, targetFile);
console.log(`[ok] Skill installed: ${targetFile}`);
console.log('');
console.log('Next steps:');
console.log('  1. Ensure the linksee-memory MCP server is registered:');
console.log('       claude mcp add -s user linksee -- npx -y linksee-memory');
console.log('');
console.log('  2. Restart Claude Code (the skill auto-loads on next turn).');
console.log('');
console.log('  3. Test by saying something like:');
console.log('       "How did we solve this before?"');
console.log('       "Same error again"');
console.log('       "Remember: I prefer TypeScript over JavaScript"');
console.log('     or in Japanese:');
console.log('       「前にこの問題どう解決したっけ」');
console.log('       「覚えておいて: ...」');
console.log('');
console.log('The skill will trigger and call recall/remember automatically.');
