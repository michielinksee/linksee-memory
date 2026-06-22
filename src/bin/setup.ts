#!/usr/bin/env node
// setup: One-command setup for Linksee Memory — the "Use Linksee" installer.
//
// Usage:
//   npx linksee-memory setup          (interactive setup)
//   npx linksee-memory setup --yes    (accept all defaults, no prompts)
//   npx linksee-memory setup --dry-run
//
// Does four things:
//   1. Registers the MCP server with Claude Code
//   2. Installs the SKILL.md (agent trigger phrases)
//   3. Configures the Stop hook (auto-capture sessions) — user-global
//   4. Offers to wire the re-injection guard into THIS project's .claude/settings.json
//
// After setup, every Claude Code session:
//   - Auto-captures decisions, learnings, caveats to local memory
//   - Agent auto-recalls past context at task start (via SKILL.md triggers)
//   - (if guard enabled) accepted decisions are re-injected before edits + on session start
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
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const autoYes = args.includes('--yes') || args.includes('-y');
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log(`linksee-memory-setup — One-command setup for Linksee Memory

Usage:
  npx linksee-memory setup          Interactive setup
  npx linksee-memory setup --yes    Accept all defaults, no prompts
  npx linksee-memory setup --dry-run Show what would happen

What it does:
  1. Registers linksee-memory MCP server with Claude Code
  2. Installs SKILL.md (teaches the agent when to recall/remember)
  3. Configures Stop hook (auto-captures every session)
  4. Offers to wire the re-injection guard into THIS project's .claude/settings.json

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
// Subcommand form (npx -y linksee-memory <sub>) so the hooks resolve for a cold user —
// npx can resolve the package name, but not sibling bin names like linksee-memory-sync.
const HOOK_COMMAND = 'npx -y linksee-memory sync';

// Re-injection guard — wired into the PROJECT (not user-global) settings, because it enforces THIS
// project's accepted decisions. Mirrors the dogfood wiring's ${CLAUDE_PROJECT_DIR}/dist/bin path, but
// points at the globally-installed `linksee-memory-guard` bin so it ships without a build step. Shell
// form (resolved at run time) survives npx-cache eviction; a baked dist path would not.
const GUARD_COMMAND = 'npx -y linksee-memory guard';
const PROJECT_DIR = process.cwd();
const PROJECT_CLAUDE_DIR = join(PROJECT_DIR, '.claude');
const PROJECT_SETTINGS_PATH = join(PROJECT_CLAUDE_DIR, 'settings.json');

// Opt-in telemetry consent recorded at setup time (read by telemetry.ts getTelemetryMode).
const TELEMETRY_DIR = process.env.LINKSEE_MEMORY_DIR ?? join(HOME, '.linksee-memory');
const TELEMETRY_CONSENT_FILE = join(TELEMETRY_DIR, 'telemetry-consent');

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

console.log(`${BOLD}[1/4]${RESET} Registering MCP server...`);

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

console.log(`${BOLD}[2/4]${RESET} Installing agent skill...`);

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

console.log(`${BOLD}[3/4]${RESET} Configuring auto-capture hook...`);

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

// ── Step 4: Wire the re-injection guard (project-scoped, opt-in) ──────────

interface GuardHookCmd {
  type: string;
  command?: string;
  timeout?: number;
  args?: string[];
}
interface GuardHookEntry {
  matcher?: string;
  hooks?: GuardHookCmd[];
}
interface ProjectSettings {
  hooks?: Record<string, GuardHookEntry[]>;
  [k: string]: unknown;
}

const GUARD_EVENTS = ['SessionStart', 'PreToolUse'] as const;
const GUARD_HOOKS: Record<(typeof GUARD_EVENTS)[number], GuardHookEntry> = {
  // matchers + timeouts mirror the dogfood .claude/settings.json
  SessionStart: { matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 15 }] },
  PreToolUse: { matcher: 'Edit|Write|Bash', hooks: [{ type: 'command', command: GUARD_COMMAND, timeout: 8 }] },
};

// Idempotency probe: is OUR guard already wired for this event? (Match by bin name so a manually-added
// or previously-installed entry isn't duplicated, and other people's hooks are never touched.)
function guardWiredFor(s: ProjectSettings, ev: string): boolean {
  return (s.hooks?.[ev] ?? []).some((entry) =>
    entry?.hooks?.some((h) => typeof h?.command === 'string' && h.command.includes('linksee-memory-guard'))
  );
}

function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      if (a === '') return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

async function configureGuard(): Promise<boolean> {
  console.log(`${BOLD}[4/4]${RESET} Configuring re-injection guard (this project)...`);

  let project: ProjectSettings = {};
  if (existsSync(PROJECT_SETTINGS_PATH)) {
    try {
      // Strip a leading BOM (U+FEFF) — Windows editors (Notepad) emit UTF-8+BOM, which JSON.parse rejects.
      const raw = readFileSync(PROJECT_SETTINGS_PATH, 'utf8');
      project = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch {
      // Never clobber a file we can't parse — the user may have hand-authored it.
      console.log(`  ${FAIL} Could not parse ${PROJECT_SETTINGS_PATH} — left untouched`);
      console.log(`  ${DIM}Add the guard block by hand (see README → Re-injection Guard).${RESET}`);
      return false;
    }
  }

  if (GUARD_EVENTS.every((ev) => guardWiredFor(project, ev))) {
    console.log(`  ${SKIP} Guard already wired in ${PROJECT_SETTINGS_PATH}`);
    return true;
  }

  if (dryRun) {
    console.log(`  ${DIM}[dry-run] Would merge SessionStart + PreToolUse guard hooks into ${PROJECT_SETTINGS_PATH}${RESET}`);
    return false;
  }

  // "Offer" — opt-in, because the guard can deny tool calls on a 'hard' contradiction.
  if (!autoYes) {
    if (!process.stdin.isTTY) {
      console.log(`  ${SKIP} Skipped (non-interactive shell). Re-run with --yes, or paste the README block.`);
      return false;
    }
    console.log(`  ${DIM}Re-injects your accepted decisions before Edit/Write/Bash and on session start.`);
    console.log(`  Fail-open — only an action that contradicts a 'hard' anchor is ever blocked.${RESET}`);
    const ok = await askYesNo(`  Wire it into ${PROJECT_SETTINGS_PATH}?`);
    if (!ok) {
      console.log(`  ${SKIP} Skipped. Enable later via the README → Re-injection Guard.`);
      return false;
    }
  }

  // Merge, don't replace: append only the events we don't already own; leave foreign hooks intact.
  const hooks: Record<string, GuardHookEntry[]> = project.hooks ?? (project.hooks = {});
  for (const ev of GUARD_EVENTS) {
    if (!Array.isArray(hooks[ev])) hooks[ev] = [];
    if (!guardWiredFor(project, ev)) hooks[ev].push(GUARD_HOOKS[ev]);
  }

  mkdirSync(PROJECT_CLAUDE_DIR, { recursive: true });
  writeFileSync(PROJECT_SETTINGS_PATH, JSON.stringify(project, null, 2), 'utf8');
  console.log(`  ${CHECK} Guard wired → ${PROJECT_SETTINGS_PATH}`);
  return true;
}

const guardConfigured = await configureGuard();
console.log('');

// ── Telemetry consent (opt-in, anonymous, off unless you agree) ──────────
async function configureTelemetryConsent(): Promise<void> {
  console.log(`${BOLD}Anonymous usage stats${RESET} ${DIM}(optional)${RESET}`);

  const env = (process.env.LINKSEE_TELEMETRY || '').toLowerCase().trim();
  if (env) {
    console.log(`  ${SKIP} Controlled by LINKSEE_TELEMETRY=${env} ${DIM}(env overrides)${RESET}`);
    return;
  }
  if (existsSync(TELEMETRY_CONSENT_FILE)) {
    let cur = 'off';
    try { cur = (readFileSync(TELEMETRY_CONSENT_FILE, 'utf8').trim().toLowerCase()) || 'off'; } catch { /* ignore */ }
    console.log(`  ${SKIP} Already chosen: ${cur === 'basic' ? 'on' : 'off'} ${DIM}(edit ${TELEMETRY_CONSENT_FILE} to change)${RESET}`);
    return;
  }
  if (dryRun) {
    console.log(`  ${DIM}[dry-run] Would ask whether to share anonymous usage stats${RESET}`);
    return;
  }
  const dnt = process.env.DO_NOT_TRACK === '1' || process.env.DO_NOT_TRACK === 'true';
  if (dnt || autoYes || !process.stdin.isTTY) {
    try { mkdirSync(TELEMETRY_DIR, { recursive: true }); writeFileSync(TELEMETRY_CONSENT_FILE, 'off'); } catch { /* best-effort */ }
    const why = dnt ? 'DO_NOT_TRACK' : autoYes ? '--yes → off' : 'non-interactive';
    console.log(`  ${SKIP} Left off ${DIM}(${why})${RESET}`);
    return;
  }

  console.log(`  ${DIM}Helps us see which workflows actually work. Anonymous counts only —`);
  console.log(`  never your memory, code, prompts, file contents, entity names, or paths.`);
  console.log(`  Off unless you say yes; change anytime with LINKSEE_TELEMETRY=off.${RESET}`);
  const ok = await askYesNo('  Share anonymous usage stats?', false);
  try {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
    writeFileSync(TELEMETRY_CONSENT_FILE, ok ? 'basic' : 'off');
  } catch { /* best-effort */ }
  console.log(`  ${ok ? CHECK : SKIP} Telemetry ${ok ? 'enabled — thank you!' : 'left off'}`);
}

await configureTelemetryConsent();
console.log('');

// ── Summary ──────────────────────────────────────────────

console.log(`${BOLD}Setup complete!${RESET}`);
console.log('');
console.log('How it works:');
console.log(`  ${DIM}• Every session is auto-captured (decisions, caveats, learnings)${RESET}`);
console.log(`  ${DIM}• Agent auto-recalls past context when starting a task${RESET}`);
console.log(`  ${DIM}• Memory is local-first (your memory never leaves your machine)${RESET}`);
console.log(`  ${DIM}• Works across Claude Code, Cursor, Windsurf, Codex, Gemini (cross-agent)${RESET}`);
if (guardConfigured) {
  console.log(`  ${DIM}• Re-injection guard re-surfaces this project's accepted decisions before edits${RESET}`);
}
console.log('');
console.log('Test by asking:');
console.log(`  ${BOLD}"How did we solve this before?"${RESET}`);
console.log(`  ${BOLD}"Same error again"${RESET}`);
console.log(`  ${BOLD}"Remember: I prefer TypeScript over JavaScript"${RESET}`);
console.log(`  ${BOLD}「前にこの問題どう解決したっけ」${RESET}`);
console.log('');
console.log(`Or add ${BOLD}"Use Linksee"${RESET} to any prompt to trigger memory recall.`);
console.log('');
