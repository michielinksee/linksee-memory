#!/usr/bin/env node
// setup: One-command setup for Linksee Memory — the "Use Linksee" installer.
//
// Usage:
//   npx linksee-memory-setup          (interactive setup)
//   npx linksee-memory-setup --yes    (accept all defaults, no prompts)
//   npx linksee-memory-setup --dry-run
//
// Does three things:
//   1. Registers the MCP server with Claude Code
//   2. Installs the SKILL.md (agent trigger phrases)
//   3. Configures the Stop hook (auto-capture sessions)
//
// After setup, every Claude Code session:
//   - Auto-captures decisions, learnings, caveats to local memory
//   - Agent auto-recalls past context at task start (via SKILL.md triggers)
//   - "Use Linksee" in any prompt forces a recall
//
// Why: Competing memory tools (claude-mem, etc.) are one-install-and-done.
// Our MCP approach gives more precision, but the setup was 3 manual steps.
// This command eliminates that friction entirely.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const autoYes = args.includes('--yes') || args.includes('-y');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`linksee-memory-setup — One-command setup for Linksee Memory

Usage:
  npx linksee-memory-setup          Interactive setup
  npx linksee-memory-setup --yes    Accept all defaults, no prompts
  npx linksee-memory-setup --dry-run Show what would happen

What it does:
  1. Registers linksee-memory MCP server with Claude Code
  2. Installs SKILL.md (teaches the agent when to recall/remember)
  3. Configures Stop hook (auto-captures every session)

After setup, just chat with Claude Code normally.
Add "Use Linksee" to any prompt to trigger memory recall.`);
  process.exit(0);
}

// ── Constants ────────────────────────────────────────────
const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const SKILL_DIR = join(CLAUDE_DIR, 'skills', 'linksee-memory');
const SKILL_TARGET = join(SKILL_DIR, 'SKILL.md');
const __filename = fileURLToPath(import.meta.url);
const SKILL_SRC = join(dirname(__filename), '..', 'skill', 'SKILL.md');

const SERVER_NAME = 'linksee';
const MCP_COMMAND = `claude mcp add -s user ${SERVER_NAME} -- npx -y linksee-memory`;
const HOOK_COMMAND = 'npx -y linksee-memory-sync';

const CHECK = '\x1b[32m✓\x1b[0m';
const SKIP = '\x1b[33m○\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

console.log('');
console.log(`${BOLD}Linksee Memory Setup${RESET}`);
console.log(`${DIM}Local-first cross-LLM memory · precision recall${RESET}`);
console.log('');

// ── Step 1: Register MCP server ──────────────────────────

console.log(`${BOLD}[1/3]${RESET} Registering MCP server...`);

let mcpAlreadyRegistered = false;
try {
  // Check if already registered by looking at settings.json or .claude.json
  for (const confFile of [SETTINGS_PATH, join(HOME, '.claude.json')]) {
    if (!existsSync(confFile)) continue;
    try {
      const conf = JSON.parse(readFileSync(confFile, 'utf8'));
      if (conf?.mcpServers?.[SERVER_NAME]) {
        mcpAlreadyRegistered = true;
        break;
      }
    } catch { /* ignore parse errors */ }
  }
} catch { /* ignore */ }

if (mcpAlreadyRegistered) {
  console.log(`  ${SKIP} MCP server '${SERVER_NAME}' already registered`);
} else if (dryRun) {
  console.log(`  ${DIM}[dry-run] Would run: ${MCP_COMMAND}${RESET}`);
} else {
  try {
    // Check if 'claude' CLI is available
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (which.status !== 0) {
      console.log(`  ${FAIL} 'claude' CLI not found. Install Claude Code first:`);
      console.log(`    https://docs.anthropic.com/en/docs/claude-code`);
      console.log(`  ${DIM}Then run this setup again.${RESET}`);
    } else {
      const r = spawnSync('claude', ['mcp', 'add', '-s', 'user', SERVER_NAME, '--', 'npx', '-y', 'linksee-memory'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (r.status === 0) {
        console.log(`  ${CHECK} MCP server registered as '${SERVER_NAME}'`);
      } else {
        // May fail if already exists with different config
        const stderr = (r.stderr || '').trim();
        if (stderr.includes('already exists') || stderr.includes('already registered')) {
          console.log(`  ${SKIP} MCP server '${SERVER_NAME}' already registered`);
        } else {
          console.log(`  ${FAIL} Registration failed: ${stderr || 'unknown error'}`);
          console.log(`  ${DIM}Manual: ${MCP_COMMAND}${RESET}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`  ${FAIL} Error: ${e?.message ?? e}`);
    console.log(`  ${DIM}Manual: ${MCP_COMMAND}${RESET}`);
  }
}
console.log('');

// ── Step 2: Install SKILL.md ─────────────────────────────

console.log(`${BOLD}[2/3]${RESET} Installing agent skill...`);

if (!existsSync(SKILL_SRC)) {
  console.log(`  ${FAIL} Bundled SKILL.md not found (packaging bug)`);
  console.log(`  ${DIM}Expected at: ${SKILL_SRC}${RESET}`);
} else if (dryRun) {
  console.log(`  ${DIM}[dry-run] Would copy to: ${SKILL_TARGET}${RESET}`);
} else {
  mkdirSync(SKILL_DIR, { recursive: true });

  let shouldWrite = true;
  if (existsSync(SKILL_TARGET)) {
    try {
      const existing = readFileSync(SKILL_TARGET, 'utf8');
      const bundled = readFileSync(SKILL_SRC, 'utf8');
      if (existing === bundled) {
        console.log(`  ${SKIP} Skill already installed and up to date`);
        shouldWrite = false;
      } else {
        // Newer version — overwrite
        console.log(`  ${DIM}Updating to latest version...${RESET}`);
      }
    } catch { /* fallthrough to write */ }
  }

  if (shouldWrite) {
    copyFileSync(SKILL_SRC, SKILL_TARGET);
    console.log(`  ${CHECK} Skill installed → ${SKILL_TARGET}`);
  }
}
console.log('');

// ── Step 3: Configure Stop hook ──────────────────────────

console.log(`${BOLD}[3/3]${RESET} Configuring auto-capture hook...`);

interface SettingsJson {
  hooks?: {
    Stop?: Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

let settings: SettingsJson = {};
if (existsSync(SETTINGS_PATH)) {
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    console.log(`  ${FAIL} Could not parse ${SETTINGS_PATH}`);
    settings = {};
  }
}

// Check if hook already exists
const stopHooks = settings?.hooks?.Stop ?? [];
const alreadyHooked = stopHooks.some((entry) =>
  entry.hooks?.some((h) => h.command?.includes('linksee-memory-sync'))
);

if (alreadyHooked) {
  console.log(`  ${SKIP} Stop hook already configured`);
} else if (dryRun) {
  console.log(`  ${DIM}[dry-run] Would add Stop hook to ${SETTINGS_PATH}${RESET}`);
} else {
  // Add hook
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];

  settings.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: HOOK_COMMAND }],
  });

  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  console.log(`  ${CHECK} Stop hook added → ${SETTINGS_PATH}`);
}
console.log('');

// ── Summary ──────────────────────────────────────────────

console.log(`${BOLD}Setup complete!${RESET}`);
console.log('');
console.log('How it works:');
console.log(`  ${DIM}• Every session is auto-captured (decisions, caveats, learnings)${RESET}`);
console.log(`  ${DIM}• Agent auto-recalls past context when starting a task${RESET}`);
console.log(`  ${DIM}• Memory is local-first (nothing leaves your machine)${RESET}`);
console.log(`  ${DIM}• Works across Claude Code, Cursor, ChatGPT (cross-LLM)${RESET}`);
console.log('');
console.log('Test by asking:');
console.log(`  ${BOLD}"How did we solve this before?"${RESET}`);
console.log(`  ${BOLD}"Same error again"${RESET}`);
console.log(`  ${BOLD}"Remember: I prefer TypeScript over JavaScript"${RESET}`);
console.log(`  ${BOLD}「前にこの問題どう解決したっけ」${RESET}`);
console.log('');
console.log(`Or add ${BOLD}"Use Linksee"${RESET} to any prompt to trigger memory recall.`);
console.log('');
