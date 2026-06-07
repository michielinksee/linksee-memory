// scripts/seed-anchors.mjs — Build-order step 2: curate the candidate pool into drift anchors.
//
// NOT published (outside files[]). Re-runnable UPSERT: inserts new anchors, refreshes the
// lexical bridge (affects/detect_terms/violation_signal/statement/rationale) of existing ones.
//
// declare-don't-mine: every anchor was HAND-REVIEWED from a real memory row, and the lexical
// bridge was attached by the curator — that review is what makes the anchor clean. Raw-conversation
// rows misclassified as rule_or_warning (56501, 33508, 33506...) were REJECTED, not seeded.
//
// affects are calibrated to REAL session_file_edits.file_path values (absolute Windows paths,
// mixed separators). The detector normalizes path+glob to lowercase forward-slash and matches by
// substring/structure, so affects here are lowercase forward-slash fragments of the real tree:
//   linksee-memory/  linksee-dashboard/  kansei-link-mcp/  sake_navi/  reviewlens  apps/mobile
//
// Usage: node scripts/seed-anchors.mjs   (uses the live linksee-memory DB via openDb())

import { openDb, runMigrations } from '../dist/db/migrate.js';
import { curateAnchorFromMemory, listAnchors } from '../dist/lib/drift-anchors.js';

const ANCHORS = [
  // ── linksee-memory (meta: drift on the drift tool's own repo) ──
  {
    src: 334815,
    kind: 'decision',
    statement: 'linksee-memory MCPの公開ツールは3つ（remember / recall / read_smart）。8→3に統合し、4つ目を足さない。',
    rationale:
      '8ツールはClaude/GPT/Cursor/Codex/Geminiで挙動がモデル依存にブレた。Context7式に最小化。read_smartはトークン削減の柱として残す。',
    affects: ['linksee-memory/src/mcp/server.ts', 'linksee-memory/package.json'],
    detect_terms: ['MCP', 'tool', 'server.ts', 'TOOLS', 'remember', 'recall', 'read_smart'],
    violation_signal: ['recall_file', 'forget', 'consolidate', 'list_entities', 'update_memory'],
  },
  {
    src: 293075,
    kind: 'constraint',
    statement:
      '現行の6-layer memories DBスキーマは作り直さない。新機能はcontent JSONへのフィールド段階追加で行い、破壊的マイグレーションを禁止する。',
    rationale:
      'Memory(エージェント最適化)とDashboard(人間最適化)は同一データの2ビュー。テーブルを作り直すと両ビューと既存2k件の記憶が壊れる。最悪でも元に戻せる加算設計を保つ（Michieの明示制約）。',
    affects: ['linksee-memory/src/db/schema.sql', 'linksee-memory/src/db/migrate.ts'],
    detect_terms: ['schema', 'migration', 'memories', 'content JSON', 'layer', 'ALTER', 'DROP'],
    violation_signal: ['DROP TABLE memories', 'ALTER TABLE memories DROP', 'recreate memories', 'rebuild schema', 'DELETE FROM memories'],
  },
  {
    src: 293549,
    kind: 'constraint',
    statement:
      'session-extractorは生チャットテキストをそのまま保存しない。5W1H + 3-axis分類で構造化抽出してから保存する。',
    rationale:
      "旧フォーマットは『そうだね。全部やろう。』のような生テキストを保存し、Dashboard TimelineとOpen Loopsにノイズを出した。",
    affects: ['linksee-memory/src/lib/session-extractor.ts', 'linksee-memory/src/skill/skill.md', 'linksee-dashboard/lib/agent-brain.ts'],
    detect_terms: ['session-extractor', 'raw text', '5W1H', '3-axis', 'structured', 'content'],
    violation_signal: ['raw chat', 'rawText', 'store raw', 'verbatim transcript', 'content = message'],
  },

  // ── linksee-dashboard ──
  {
    src: 273165,
    kind: 'prohibition',
    statement:
      'ダッシュボードUIは毎回コードを新規生成しない（V0/Lovable型を却下）。生成は「提案→lock→tweak」モデルで、見るたびに変わってはいけない。',
    rationale:
      '毎回生成は信頼性・レイテンシ・自由度過剰で却下。第二の脳は「いつもの場所にある」べき。本当の壁は技術ではなく語彙（どの5-6ビュー原型が効くか）。',
    affects: ['linksee-dashboard/'],
    detect_terms: ['dashboard', 'generate', 'render', 'Lovable', 'codegen'],
    violation_signal: ['v0.dev', 'Lovable', 'generateUI', 'per-render generation', 'runtime codegen', 'streamUI'],
  },

  // ── ScaNavi / ReviewLens (sake & cosmetics scan apps) ──
  {
    src: 275326,
    kind: 'prohibition',
    statement:
      'Cosmetic-Info.jpへの自動クロール／robots.txt無視／VPN回避スクレイピングは提案も実装もしない（サイトの明示意思に反する）。',
    rationale:
      'Cosmetic-Info.jpはClaudeBot/GPTBot等をrobots.txtで全面ブロックし海外アクセスも遮断。合法経路はGemini OCR・ブランド公式表示・日本在住者の人間ブラウズ参照のみ。',
    affects: ['reviewlens', 'scrape', 'scraper', 'crawl'],
    detect_terms: ['Cosmetic-Info', 'scrape', 'robots', 'VPN', 'crawl', 'クロール', '成分'],
    violation_signal: ['Cosmetic-Info', 'ignore robots', '--ignore-robots', 'robots bypass', 'VPN', 'proxy scrape'],
  },
  {
    src: 167980,
    kind: 'prohibition',
    statement:
      'ScaNavi(SakeNavi)にトークン/仮想通貨報酬・NFTコレクタブル・Play to Earn型の仕組みは導入しない（絶対NG, Michie明言 2026-05-19）。',
    rationale:
      '投機層が入ると蔵元が欲しいデータ品質が崩壊し、酒好きの重要顧客を追い出す。DEAがDEAPcoin価値維持で苦労した前例。',
    affects: ['sake_navi'],
    detect_terms: ['reward', 'token', 'NFT', 'crypto', 'Play to Earn', '報酬', 'コレクタブル', 'ポイント'],
    violation_signal: ['token reward', 'NFT', 'mint', 'play-to-earn', 'P2E', 'tokenomics', 'DEAPcoin', 'airdrop'],
  },
  {
    src: 276250,
    kind: 'constraint',
    statement:
      '化粧品の新成分追加時は必ずcheck_new_ingredient()でINCI/alias重複チェックを行う。INCI名をグローバル正規化キー、JCIA化粧品表示名称をcanonical_jaとする。',
    rationale:
      '同一物質の日本語表記が複数存在し(化粧品表示名称/医薬部外品名/慣用名)、怠ると同一物質が別エントリ化し片方だけ留意成分扱いになる致命的バグ。011_fancl_expansionで実際に16ペア発生(2026-05-26)。',
    affects: ['ingredient', 'reviewlens'],
    detect_terms: ['ingredient', 'INCI', 'alias', 'check_new_ingredient', '成分', '留意成分', 'resolve_ingredient_name'],
    violation_signal: [], // constraint — detector surfaces implements/absent against ingredient migrations
  },
  {
    src: 58911,
    kind: 'decision',
    statement:
      'SakeNaviチャットの銘柄リンクは回答テキストの銘柄スキャンで作らない。【推薦銘柄】行でLLMに明示的に日本語銘柄名を出力させる方式を採用する。',
    rationale:
      'テキストスキャンは「純米大吟醸/gin/寿」等の一般語が誤マッチする温床。重複(夢は正夢 ID:3702 vs Yume wa Masayume ID:3591)もID+テキスト種別で排除が必要。',
    affects: ['sake_navi'],
    detect_terms: ['銘柄', 'recommendation', '推薦銘柄', 'text scan', 'link', 'brand'],
    violation_signal: ['scanText', 'regex brand match', 'keyword match 銘柄', 'substring 銘柄'],
  },

  // ── KanseiLink ──
  {
    src: 367707,
    kind: 'constraint',
    statement:
      'KanseiLinkの信頼性表示はlive telemetryとseed/eval estimateを分離する。headlineのsuccess_rateはlive-onlyで、seed由来の数値を混ぜない。',
    rationale:
      "service_stats.success_rateがseed+liveを混ぜていたため『github 17%』のような推定値が実測のように表示されていた。",
    affects: [
      'kansei-link-mcp/src/utils/reliability-source.ts',
      'kansei-link-mcp/src/tools/get-service-tips.ts',
      'kansei-link-mcp/src/tools/search-services.ts',
    ],
    detect_terms: ['success_rate', 'reliability', 'service_stats', 'seed', 'live', 'provenance', 'telemetry'],
    violation_signal: ['blended success_rate', 'seed + live', 'service_stats.success_rate', 'mix seed'],
  },

  // ── CardWize / ReviewLens-App (Expo mobile) ──
  {
    src: 68316,
    kind: 'decision',
    statement: 'Expo mobile appはSDK 54を使う。SDK 55はExpo Goと非互換のため上げない。',
    rationale: 'Expo SDK 55はExpo Goと非互換でiPhoneがwhite screenになった→EAS Build/SDK 54で安定。',
    affects: ['apps/mobile', 'app.json'],
    detect_terms: ['Expo', 'SDK', 'expo-go', 'sdkVersion'],
    violation_signal: ['expo@55', '"expo": "^55', '"expo": "~55', 'sdkVersion: 55', 'SDK 55'],
  },
];

const db = openDb();
runMigrations(db);

const existsStmt = db.prepare("SELECT id FROM drift_anchors WHERE source_memory_id = ? AND status = 'active'");
const updateStmt = db.prepare(`
  UPDATE drift_anchors
     SET statement = @statement, rationale = @rationale, affects = @affects,
         detect_terms = @detect_terms, violation_signal = @violation_signal, updated_at = unixepoch()
   WHERE id = @id
`);
const toJ = (a) => JSON.stringify((a ?? []).map((x) => String(x).trim()).filter(Boolean));

const inserted = [];
const updated = [];
const failed = [];

const run = db.transaction(() => {
  for (const a of ANCHORS) {
    try {
      const existing = existsStmt.get(a.src);
      if (existing) {
        updateStmt.run({
          id: existing.id,
          statement: a.statement,
          rationale: a.rationale ?? null,
          affects: toJ(a.affects),
          detect_terms: toJ(a.detect_terms),
          violation_signal: toJ(a.violation_signal),
        });
        updated.push({ id: existing.id, src: a.src });
      } else {
        const row = curateAnchorFromMemory(db, a.src, {
          kind: a.kind,
          statement: a.statement,
          rationale: a.rationale,
          affects: a.affects,
          detect_terms: a.detect_terms,
          violation_signal: a.violation_signal,
        });
        inserted.push({ id: row.id, kind: row.kind, src: a.src });
      }
    } catch (err) {
      failed.push({ src: a.src, error: err?.message ?? String(err) });
    }
  }
});
run();

console.log('=== seed result ===');
console.log(JSON.stringify({ inserted: inserted.length, updated: updated.length, failed: failed.length }, null, 2));
if (inserted.length) console.log('inserted:', JSON.stringify(inserted));
if (updated.length) console.log('updated (bridge refreshed):', JSON.stringify(updated));
if (failed.length) console.log('FAILED:', JSON.stringify(failed, null, 2));

const active = listAnchors(db, { status: 'active' });
const byKind = active.reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {});
console.log('=== active anchors now ===');
console.log(JSON.stringify({ total: active.length, byKind }, null, 2));

db.close();
