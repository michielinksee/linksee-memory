// share_draft — build a link to KanseiLINK's reviewed draft page for an agent field note.
//
// What this does: checks a fixed set of fields, and returns a URL. Nothing else.
//   - Linksee itself makes NO network call here. The human opens the link, reads the
//     filled form, and only their click on that page sends anything.
//   - No free text beyond the fixed fields. Each field has a length cap, and any field that
//     looks like it carries a secret stops the build — we return which field and why,
//     never a link. (The page masks again on display; we refuse earlier because the URL
//     itself passes through the page host's request logs.)
//   - Fields are filled by the agent from what the user wants to share. This module never
//     reads memory to fill them.
//
// Target page: https://kansei-link.com/agents/note/new.html — it reads exactly these query
// keys: service, task, symptom, tried, result, conditions, kind, runtime (and trims the query
// to 2,000 characters).

export const DRAFT_PAGE = 'https://kansei-link.com/agents/note/new.html';
export const URL_MAX = 2000;

export const KINDS = ['execution', 'documentation', 'hypothesis'] as const;
export const RUNTIMES = ['claude', 'codex', 'gpt', 'gemini', 'other'] as const;

/** Text fields in URL order, with the page's caps (same numbers as the page's maxlength). */
export const TEXT_FIELDS = [
  { key: 'task', max: 300, required: true },
  { key: 'symptom', max: 600, required: true },
  { key: 'tried', max: 2000, required: true },
  { key: 'result', max: 1000, required: true },
  { key: 'conditions', max: 600, required: false },
] as const;

export const ALLOWED_KEYS = ['service', ...TEXT_FIELDS.map((f) => f.key), 'kind', 'runtime'] as const;

export const SERVICE_RE = /^[a-z0-9_.-]{1,160}$/;

export const NOTICE = [
  'この内容は、開いた画面で確認してから送られます。送るまでどこにも出ていません。',
  'URL の中身は KanseiLINK の通信の記録（Cloudflare）を通ります。秘密は入れないでください。',
] as const;

export const NOTICE_EN = [
  'Nothing is sent yet: the page opens with these fields filled, and only your click there sends them.',
  'The URL passes through KanseiLINK\'s request logs (Cloudflare). Do not put secrets in it.',
] as const;

// ── Secret shapes ──────────────────────────────────────────────────────────────
// Ported from KanseiLINK `src/utils/secret-mask.ts` (kansei-link/kansei-internal @ f39362a,
// file last changed in 5cdd578), copied 2026-10-30. Same TENANT_HOSTS list as the draft page
// (public/agents/note/new.html, which is itself a port of secret-mask.ts). Keep in sync.
//
// Differences, because here a match BLOCKS instead of masking:
//   - Added: IP addresses, local paths (C:\, /Users/, /home/), bare tenant hosts without a scheme.
//   - Long base64-ish blobs from 32 chars (the mask uses 40), but only when the run mixes letters
//     and digits — so long error codes like PERMISSION_DENIED_INSUFFICIENT_SCOPES pass.
//   - Bearer/Basic/Token needs a digit in the value (or 20+ chars), so "token authentication"
//     in prose passes; a real credential nearly always has one.
//   - A URL is blocked only when its host is a tenant of a TENANT_HOSTS service; other URLs
//     (public docs) pass.
const TENANT_HOSTS = [
  'slack.com', 'atlassian.net', 'kintone.com', 'cybozu.com', 'zendesk.com', 'freshdesk.com',
  'myshopify.com', 'salesforce.com', 'my.salesforce.com', 'lightning.force.com', 'okta.com',
  'auth0.com', 'hubspot.com', 'notion.site', 'sharepoint.com', 'onmicrosoft.com', 'zoom.us',
  'monday.com', 'asana.com', 'intercom.io', 'chatwork.com', 'smarthr.jp', 'secure.freee.co.jp',
  'backlog.com', 'backlog.jp', 'box.com', 'github.io', 'supabase.co', 'vercel.app', 'railway.app',
  'herokuapp.com', 'workers.dev', 'pages.dev',
];
const GENERIC_LABELS = new Set(['www', 'api', 'app', 'docs', 'developer', 'developers', 'accounts', 'login', 'auth', 'secure', 'status', 'help', 'support', 'cdn', 'mail']);

function tenantOf(host: string): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  for (const base of TENANT_HOSTS) {
    if (h.endsWith('.' + base) && h.length > base.length + 1) {
      const first = h.slice(0, h.length - base.length - 1).split('.').pop() ?? '';
      if (GENERIC_LABELS.has(first)) continue; // api.slack.com is the vendor, not a tenant
      return base;
    }
  }
  return null;
}

type Finder = { kind: string; ja: string; find: (s: string) => boolean };

const has = (re: RegExp) => (s: string) => { re.lastIndex = 0; return re.test(s); };
const mixed = (t: string) => /[A-Za-z]/.test(t) && /\d/.test(t);

const FINDERS: Finder[] = [
  {
    kind: 'BEARER', ja: '認証ヘッダーの値（Bearer／Basic／Token …）',
    find: (s) => {
      const re = /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9\-._~+/=]{8,})/gi;
      for (const m of s.matchAll(re)) if (/\d/.test(m[1]) || m[1].length >= 20) return true;
      return false;
    },
  },
  {
    kind: 'API_KEY', ja: 'API キー・トークンの形（sk-・ghp_・github_pat_・xox?-・AKIA・AIza など）',
    find: has(/\b(?:sk-ant-[A-Za-z0-9\-_]{8,}|sk-[A-Za-z0-9\-_]{8,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9\-]{8,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9\-_]{20,})/g),
  },
  {
    kind: 'KV_SECRET', ja: '秘密の値の書き方（token=…・password: … など）',
    find: has(/\b(access_token|refresh_token|id_token|api[_-]?key|apikey|client_secret|secret|password|passwd|token|signature|sig)(["']?\s*[=:]\s*)(?:"([^"\r\n]+)"|'([^'\r\n]+)'|[A-Za-z0-9\-._~+/%]{6,})/gi),
  },
  {
    kind: 'JWT', ja: 'JWT の形（3 つの塊を . でつないだもの）',
    find: has(/\b[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g),
  },
  { kind: 'EMAIL', ja: 'メールアドレス', find: has(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) },
  {
    kind: 'TENANT_URL', ja: '会社ごとの URL・ホスト名（acme.slack.com など）',
    find: (s) => {
      for (const m of s.matchAll(/(?:\b[a-z][a-z0-9+.-]*:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?/gi)) {
        if (tenantOf(m[1])) return true;
      }
      return false;
    },
  },
  {
    kind: 'IP', ja: 'IP アドレス（localhost と書いてください）',
    find: (s) => {
      for (const m of s.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)/g)) {
        if (m.slice(1, 5).every((o) => Number(o) <= 255)) return true;
      }
      return has(/(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}|::1)(?![0-9a-f:])/gi)(s);
    },
  },
  {
    kind: 'LOCAL_PATH', ja: 'PC の中の道（C:\\・/Users/・/home/）',
    find: has(/(?<![A-Za-z])[A-Za-z]:[\\/]|\/(?:Users|home)\/|\\Users\\/g),
  },
  { kind: 'UUID', ja: 'UUID（要求・テナントの id）', find: has(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) },
  { kind: 'HEX', ja: '長い 16 進の塊（32 字以上）', find: has(/\b[0-9a-f]{32,}\b/gi) },
  {
    kind: 'BLOB', ja: '長い base64 などの塊（32 字以上・英字と数字が混ざったもの）',
    find: (s) => {
      for (const m of s.matchAll(/[A-Za-z0-9+=_\-]{32,}/g)) if (mixed(m[0])) return true;
      return false;
    },
  },
];

/** Which secret shapes a text contains (kinds, in check order). Empty = clean. */
export function findSecretShapes(text: string): Array<{ kind: string; ja: string }> {
  const out: Array<{ kind: string; ja: string }> = [];
  for (const f of FINDERS) if (f.find(text)) out.push({ kind: f.kind, ja: f.ja });
  return out;
}

// ── Build ──────────────────────────────────────────────────────────────────────

export interface ShareDraftProblem { field: string; reason: string; kinds?: string[] }

export type ShareDraftResult =
  | { ok: true; url: string; length: number; notice: readonly string[]; notice_en: readonly string[] }
  | { ok: false; problems: ShareDraftProblem[]; hint: string };

/**
 * Check the fields and build the draft URL. Pure: no I/O, no network, no DB.
 * Returns problems (field + reason) instead of a URL when anything is off.
 */
export function buildShareDraft(input: unknown): ShareDraftResult {
  const problems: ShareDraftProblem[] = [];
  const args = (input && typeof input === 'object' && !Array.isArray(input)) ? input as Record<string, unknown> : {};

  for (const k of Object.keys(args)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(k)) {
      problems.push({ field: k, reason: `この欄は受けません。使える欄: ${ALLOWED_KEYS.join(', ')}` });
    }
  }

  const str = (k: string): string | undefined => {
    const v = args[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') { problems.push({ field: k, reason: '文字列で渡してください' }); return undefined; }
    return v.trim();
  };

  const service = str('service');
  if (!service) problems.push({ field: 'service', reason: '必須です（KanseiLINK の service_id、例: freee, slack）' });
  else if (!SERVICE_RE.test(service)) problems.push({ field: 'service', reason: '形が違います。小文字・数字・_ . - だけで 160 字まで（例: freee, google-drive）' });

  const values: Record<string, string> = {};
  for (const f of TEXT_FIELDS) {
    const v = str(f.key);
    if (!v) {
      if (f.required) problems.push({ field: f.key, reason: '必須です' });
      continue;
    }
    if (v.length > f.max) {
      problems.push({ field: f.key, reason: `長すぎます（${v.length} 字・上限 ${f.max} 字）` });
      continue;
    }
    values[f.key] = v;
  }

  const kind = str('kind');
  if (!kind) problems.push({ field: 'kind', reason: `必須です: ${KINDS.join(' / ')}（実際に動かした／文書で読んだ／試していない推測）` });
  else if (!(KINDS as readonly string[]).includes(kind)) problems.push({ field: 'kind', reason: `次のどれかにしてください: ${KINDS.join(' / ')}` });

  const runtime = str('runtime');
  if (runtime !== undefined && runtime !== '' && !(RUNTIMES as readonly string[]).includes(runtime)) {
    problems.push({ field: 'runtime', reason: `次のどれかにしてください: ${RUNTIMES.join(' / ')}` });
  }

  // Secret shapes — every field, including service.
  const scan: Array<[string, string | undefined]> = [['service', service], ...Object.entries(values)];
  for (const [field, v] of scan) {
    if (!v) continue;
    const hits = findSecretShapes(v);
    if (hits.length) {
      problems.push({
        field,
        reason: `秘密に見える形があります: ${hits.map((h) => h.ja).join('・')}。値は書かず、種類だけを書いてください（例: 「401 invalid_token」「テナントの URL」）`,
        kinds: hits.map((h) => h.kind),
      });
    }
  }

  if (problems.length) {
    return { ok: false, problems, hint: 'リンクは作っていません。上の欄を直して、もう一度呼んでください。' };
  }

  const q = new URLSearchParams();
  q.set('service', service!);
  for (const f of TEXT_FIELDS) if (values[f.key]) q.set(f.key, values[f.key]);
  q.set('kind', kind!);
  if (runtime) q.set('runtime', runtime);
  const url = `${DRAFT_PAGE}?${q.toString()}`;

  if (url.length > URL_MAX) {
    const sizes = TEXT_FIELDS
      .filter((f) => values[f.key])
      .map((f) => ({ field: f.key, encoded: encodeURIComponent(values[f.key]).length }))
      .sort((a, b) => b.encoded - a.encoded);
    return {
      ok: false,
      problems: [{
        field: sizes[0]?.field ?? 'tried',
        reason: `リンクが長すぎます（${url.length} 字・上限 ${URL_MAX} 字）。短くしてください。日本語は 1 字が URL で 9 字になります。長い順: ${sizes.map((s) => `${s.field} ${s.encoded}`).join('・')}`,
      }],
      hint: 'リンクは作っていません。こちらでは欄を削りません。短くして、もう一度呼んでください。',
    };
  }

  return { ok: true, url, length: url.length, notice: NOTICE, notice_en: NOTICE_EN };
}
