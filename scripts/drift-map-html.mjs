// Standalone 4-pane Drift Map (NO server — double-click / screenshot / share). Self-contained: inline CSS + tiny
// vanilla JS for the click-to-detail Resolution Panel. Re-run to refresh. Output: linksee-memory/drift-map.html
// Panes: LEFT Intent Anchors (Primary/Stable) · CENTER Evolution Map (before→after) · RIGHT Resolution Panel
//        · BOTTOM Decision Timeline (Detected→Judged→…→Will reopen). Structure-grid + evolution-tree, NOT a hairball.
import { openDb, runMigrations } from '../dist/db/migrate.js';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const db = openDb();
runMigrations(db);
let res = {};
try { const r = db.prepare("SELECT value FROM meta WHERE key='t3_resolutions'").get(); if (r) res = JSON.parse(r.value); } catch { /* none */ }
let t2res = {};
try { const r2 = db.prepare("SELECT value FROM meta WHERE key='t2_resolutions'").get(); if (r2) t2res = JSON.parse(r2.value); } catch { /* none */ }
const a21A = (t2res && t2res.A21) ? t2res.A21 : {};
const a21cov = (a21A.covered || []).length, a21app = a21A.applicable_total || 0, a21pend = (a21A.pending || []).length, a21nr = (a21A.needs_review || []).length;
const a21tail = a21pend + ' pending' + (a21nr ? ', ' + a21nr + ' needs_review' : '');
const a21note = a21A.verified === true ? ' → ✅ fully verified (T2 sweep ' + a21app + '/' + a21app + ')'
  : a21A.verified === 'partial' ? ' → 🟡 partially verified (T2 sweep: ' + a21cov + '/' + a21app + ' emit the link; ' + a21tail + ')'
  : ' → ⚠ 実装未検出 (T2)';
const rows = db.prepare("SELECT id, statement, domain, decision_mode, confidence, status, lifecycle, review_after, affects, evidence_refs FROM drift_anchors WHERE owner='founding-strategy-doc' ORDER BY id").all();
const cardRows = db.prepare("SELECT target_node_id tid, rationale, evidence_refs, proposed_node FROM memory_write_candidates WHERE proposed_node LIKE '%\"src\":\"t3\"%' OR proposed_node LIKE '%\"src\":\"t2\"%'").all();
db.close();

const ID = { a4old: res?.A4?.superseded_node, a4new: res?.A4?.superseded_by, a5: res?.A5?.node, a21dir: res?.A21?.direction_node, a21c: res?.A21?.constraint_node };
const fmt = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '');
const a5date = fmt(res?.A5?.review_after);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const cardByTid = {}; for (const c of cardRows) cardByTid[c.tid] = c;
const fmtRefs = (refs) => (Array.isArray(refs) ? refs.map((r) => (r.source_type || '') + (r.ref ? ':' + r.ref : '')).join(' ／ ') : '');

const STATE = {
  active: { l: 'active', dot: '#10b981', cls: '' }, at_risk: { l: 'at_risk', dot: '#f59e0b', cls: 'amber' },
  superseded: { l: 'superseded', dot: '#a1a1aa', cls: 'struck' }, resolved: { l: 'resolved', dot: '#0ea5e9', cls: 'sky' },
  retired: { l: 'retired', dot: '#d4d4d8', cls: 'struck' }, constraint: { l: 'constraint', dot: '#a855f7', cls: 'purple' },
};
const labelOf = (r) => {
  if (r.id === ID.a4old) return 'A4 ／ 完全ステルス（旧・退役）';
  if (r.id === ID.a4new) return 'A4改 ／ 公開・非公開 二層';
  if (r.id === ID.a5) return 'A5 ／ Agent Insights';
  if (r.id === ID.a21dir) return 'A21 ／ app-link 必須（方向）';
  if (r.id === ID.a21c) return 'A21制約 ／ 条件付き deep-link';
  if (r.statement.includes('コア価値')) return 'A1 ／ token節約 (negawatt)';
  if (r.statement.includes('課金構造')) return 'A3 ／ 3フェーズ funnel';
  if (r.statement.includes('進化パス')) return 'A9 ／ 電話帳→食べログ→Uber';
  if (r.statement.includes('ビジネス＝KanseiLINK自体')) return 'A10 ／ AEO格付け機関';
  return '#' + r.id;
};
const stateOf = (r) => {
  if (r.status === 'retired' || r.lifecycle === 'superseded') return 'superseded';
  if (r.lifecycle === 'at_risk') return 'at_risk';
  if (r.lifecycle === 'resolved') return 'resolved';
  if (r.decision_mode === 'constraint' && r.id === ID.a21c) return 'constraint';
  return 'active';
};
const driftTypeOf = (r) => {
  const c = cardByTid[r.id]; if (c) { const v = J(c.proposed_node, {}).verdict; return v || '—'; }
  return r.id === ID.a4new || r.id === ID.a21c ? '— (evolved)' : 'convergent';
};
const actionOf = (st) => ({ superseded: '退役済・履歴保持', at_risk: '検証 or 期限で再浮上', resolved: '制約化で解決', constraint: 'src/toolsで実装検証(T2)' }[st] || '安定');

const detail = {};
const nodes = rows.map((r) => {
  const st = stateOf(r); const c = cardByTid[r.id];
  const reality = c ? c.rationale : (st === 'active' ? '直近の製品状態と整合（convergent）' : '—');
  detail[r.id] = {
    label: labelOf(r), state: STATE[st].l, driftType: driftTypeOf(r), intent: r.statement, reality,
    decision: res && Object.values(res).find((x) => x && (x.superseded_node === r.id || x.superseded_by === r.id || x.node === r.id || x.direction_node === r.id || x.constraint_node === r.id)) ?
      (Object.entries(res).find(([, x]) => x && (x.superseded_node === r.id || x.superseded_by === r.id || x.node === r.id || x.direction_node === r.id || x.constraint_node === r.id))[1].action) : (st === 'active' ? '— (no drift)' : '—'),
    evidence: fmtRefs(J(c ? c.evidence_refs : r.evidence_refs, [])),
    nextReview: fmt(r.review_after) || '—',
    files: (J(r.affects, []).join('、') || '—'),
    nextAction: actionOf(st),
  };
  return { ...r, st, label: labelOf(r) };
});

const counts = {}; for (const n of nodes) counts[n.st] = (counts[n.st] || 0) + 1;
const isPrimary = (n) => ['superseded', 'at_risk', 'resolved', 'constraint'].includes(n.st) || n.id === ID.a4new;
const primary = nodes.filter(isPrimary);
const stable = nodes.filter((n) => !isPrimary(n));

const anchorHtml = (n) => {
  const m = STATE[n.st];
  return '<div class="anchor" data-id="' + n.id + '"><i class="dot" style="background:' + m.dot + '"></i><span class="st ' + m.cls + '">' + m.l + '</span><span class="alab">' + esc(n.label) + '</span></div>';
};
const chips = Object.entries(counts).map(([s, c]) => { const m = STATE[s] || { l: s, dot: '#a1a1aa' }; return '<span class="chip"><i style="background:' + m.dot + '"></i>' + m.l + ' ' + c + '</span>'; }).join('');

// CENTER transitions
const trans = [
  { fromId: ID.a4old, from: 'A4 完全ステルス（旧）', act: 'split-supersede', toId: ID.a4new, to: 'A4改 公開/非公開 二層',
    head: 'A4 · Strategy changed', sub: 'Stealth-only → public education + private scoring logic', badge: null },
  { fromId: ID.a21dir, from: 'A21 absent（出口の痕跡なし）', act: 'fix', toId: ID.a21c, to: 'A21 条件付き deep-link 制約',
    head: 'A21 · Missing revenue loop', sub: 'Deep-link constraint created' + a21note, badge: null },
  { fromId: ID.a5, from: 'A5 Agent Insights', act: 'acknowledged', toId: ID.a5, to: 'review_after: ' + a5date,
    head: 'A5 · Strategy stalled', sub: 'Agent Insights acknowledged, but not validated yet',
    badge: 'Acknowledged, not resolved · Will reopen on ' + a5date + ' if evidence is still missing' },
];
const transHtml = trans.map((t) =>
  '<div class="block"><div class="bhead">' + esc(t.head) + '</div><div class="bsub">' + esc(t.sub) + '</div>' +
  '<div class="trans"><div class="tnode from" data-id="' + t.fromId + '">' + esc(t.from) + '</div>' +
  '<div class="arrow">↓ <span class="act">' + esc(t.act) + '</span></div>' +
  '<div class="tnode to" data-id="' + t.toId + '">' + esc(t.to) + '</div></div>' +
  (t.badge ? '<div class="badge">⚠ ' + esc(t.badge) + '</div>' : '') + '</div>').join('');

// BOTTOM timeline
const steps = [
  ['Detected', '3 drifts'], ['Judged', '3 accepted'], ['Resolved', 'A4・A21'], ['Superseded', 'A4'],
  ['Constraint created', 'A21'], ['Re-run suppressed', 'pending 0'], ['Will reopen if stale', 'A5 @ ' + a5date],
];
const timelineHtml = steps.map((s, i) => '<div class="step"><div class="sdot">' + (i + 1) + '</div><div class="slab">' + esc(s[0]) + '</div><div class="ssub">' + esc(s[1]) + '</div></div>').join('<div class="sline"></div>');

const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Drift Map — KanseiLINK</title><style>'
  + '*{box-sizing:border-box}body{margin:0;background:#fafafa;color:#27272a;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif}'
  + '.wrap{max-width:1200px;margin:0 auto;padding:0 20px}'
  + 'header{background:#fff;border-bottom:1px solid #e4e4e7;padding:18px 0}h1{font-size:22px;font-weight:600;margin:2px 0}'
  + '.sub{color:#71717a;font-size:13px;margin:3px 0 0}.subjp{color:#a1a1aa}'
  + '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}.chip{font-size:11px;padding:2px 9px;border-radius:999px;background:#f4f4f5;color:#52525b;display:inline-flex;align-items:center;gap:5px}.chip i{width:7px;height:7px;border-radius:999px}'
  + '.grid{display:grid;grid-template-columns:260px 1fr 300px;gap:16px;padding:22px 0}'
  + '.pane{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:16px}.pane h2{font-size:12px;font-weight:600;color:#3f3f46;margin:0 0 10px;text-transform:uppercase;letter-spacing:.04em}'
  + '.ph{font-size:10px;color:#a1a1aa;margin:14px 0 6px;text-transform:uppercase;letter-spacing:.05em}'
  + '.anchor{display:flex;align-items:center;gap:7px;padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}.anchor:hover{background:#f4f4f5}.anchor.sel{background:#eff6ff;border-color:#bfdbfe}'
  + '.dot{width:8px;height:8px;border-radius:999px;flex:none}.st{font:600 10px/1 ui-monospace,Menlo,monospace;text-transform:uppercase;color:#15803d;flex:none}.st.amber{color:#b45309}.st.sky{color:#0369a1}.st.purple{color:#7e22ce}.st.struck{color:#a1a1aa}'
  + '.alab{font-size:12px;color:#3f3f46;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.anchor.sel .alab{color:#1e3a8a}'
  + '.trans{margin:0 auto 18px;max-width:520px;text-align:center}.tnode{display:inline-block;width:100%;padding:10px 12px;border:1px solid #e4e4e7;border-radius:10px;cursor:pointer;font-size:12.5px;background:#fff}.tnode:hover{background:#f4f4f5}.tnode.sel{border-color:#93c5fd;background:#eff6ff}'
  + '.tnode.from{color:#a1a1aa;text-decoration:line-through}.tnode.to{color:#27272a;border-color:#d4d4d8}'
  + '.arrow{font-size:12px;color:#71717a;margin:5px 0}.act{font:600 10px/1 ui-monospace,Menlo,monospace;color:#7e22ce;text-transform:uppercase;background:#faf5ff;padding:2px 6px;border-radius:5px}'
  + '#panel{font-size:12px}#panel h3{font-size:13px;margin:0 0 10px;color:#18181b}#panel .ph0{color:#a1a1aa;font-size:12px}'
  + '.r{padding:6px 0;border-bottom:1px solid #f4f4f5}.r .k{display:block;font-size:10px;color:#a1a1aa;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}.r .v{display:block;color:#3f3f46;line-height:1.45}'
  + '.timeline{display:flex;align-items:flex-start;justify-content:space-between;gap:0;padding:16px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;margin-bottom:28px;overflow-x:auto}'
  + '.step{text-align:center;min-width:96px}.sdot{width:24px;height:24px;border-radius:999px;background:#0ea5e9;color:#fff;font:600 11px/24px ui-monospace,Menlo,monospace;margin:0 auto}.slab{font-size:11px;font-weight:600;color:#3f3f46;margin-top:5px}.ssub{font-size:10px;color:#a1a1aa}'
  + '.sline{flex:1;height:2px;background:#bae6fd;margin-top:11px;min-width:18px}'
  + '.block{margin-bottom:20px}.bhead{font-weight:600;font-size:12.5px;color:#18181b}.bsub{font-size:11px;color:#71717a;margin:1px 0 8px}.badge{margin-top:8px;font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:7px;padding:6px 10px}.loopclose{font-size:12px;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:9px 12px;margin:0 0 24px;text-align:center}.tagline{font-size:12.5px;color:#52525b;text-align:center;font-style:italic;padding:2px 0 6px}'
  + '.foot{font-size:11px;color:#a1a1aa;text-align:center;padding:0 0 8px}.gen{font-size:10px;color:#a1a1aa;text-align:center;padding:6px 0 22px}'
  + '@media(max-width:900px){.grid{grid-template-columns:1fr}}'
  + '</style></head><body>'
  + '<header><div class="wrap"><h1>Drift Map <span style="font-size:13px;font-weight:400;color:#a1a1aa">— KanseiLINK</span></h1>'
  + '<p class="sub">See where your product intent changed, stalled, or evolved.<br><span class="subjp">プロダクトの意図が、どこで変わり・止まり・進化したかを見る。</span></p>'
  + '<div class="chips">' + chips + '</div></div></header>'
  + '<div class="wrap"><div class="grid">'
  + '<div class="pane"><h2>Intent Anchors</h2><div class="ph">Primary（動いた／要監視）</div>' + primary.map(anchorHtml).join('') + '<div class="ph">Stable（整合）</div>' + stable.map(anchorHtml).join('') + '</div>'
  + '<div class="pane"><h2>Evolution Map</h2>' + transHtml + '<p class="foot">クリックで右に詳細。旧意図→retired、新意図→active、危険仮説→at_risk、解決済み→constraint化。</p></div>'
  + '<div class="pane"><h2>Resolution Panel</h2><div id="panel"><p class="ph0">← ノードをクリックすると、intent / reality / drift type / decision / evidence / next review / related files / next action が出ます。</p></div></div>'
  + '</div>'
  + '<div class="pane" style="padding:0;border:none;background:none"><h2 style="padding:0 2px">Decision Timeline</h2><div class="timeline">' + timelineHtml + '</div></div>'
  + '<div class="loopclose">Re-run result: <b>pending 0</b> — previously detected drift is now suppressed as <b>explained evolution</b>.</div>'
  + '<p class="foot">acknowledged ≠ resolved — 先送りには必ず期限が付き、未充足なら自動で再浮上する（臭いものに蓋をさせないOS）。</p>'
  + '<div class="tagline">Drift OS is not a dashboard. It is a living map of product intent.</div>'
  + '<div class="gen">static export · re-run scripts/drift-map-html.mjs to refresh · judge=Claude (pilot)</div>'
  + '</div>'
  + '<script>var D=' + JSON.stringify(detail).replace(/</g, '\\u003c') + ';'
  + 'function esc(s){s=String(s==null?"":s);return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}'
  + 'function row(k,v){return v&&v!=="—"?("<div class=\\"r\\"><span class=\\"k\\">"+k+"</span><span class=\\"v\\">"+esc(v)+"</span></div>"):"";}'
  + 'function sel(id){var n=D[id];if(!n)return;var s=document.querySelectorAll(".sel");for(var i=0;i<s.length;i++)s[i].classList.remove("sel");var t=document.querySelectorAll("[data-id=\\""+id+"\\"]");for(var j=0;j<t.length;j++)t[j].classList.add("sel");'
  + 'document.getElementById("panel").innerHTML="<h3>"+esc(n.label)+"</h3>"+row("state",n.state)+row("drift type",n.driftType)+row("intent",n.intent)+row("reality / analysis",n.reality)+row("decision",n.decision)+row("evidence",n.evidence)+row("next review",n.nextReview)+row("related files",n.files)+row("next action",n.nextAction);}'
  + 'var el=document.querySelectorAll("[data-id]");for(var k=0;k<el.length;k++){(function(e){e.addEventListener("click",function(){sel(e.getAttribute("data-id"));});})(el[k]);}'
  + 'sel(' + (ID.a4old || 'null') + ');'  // hero state: open with A4 (caught drift → supersede) pre-selected
  + '</script></body></html>';

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'drift-map.html');
writeFileSync(out, html, 'utf8');
console.log('wrote ' + out + ' (4-pane, ' + nodes.length + ' nodes, primary ' + primary.length + ' / stable ' + stable.length + ', states ' + JSON.stringify(counts) + ')');
