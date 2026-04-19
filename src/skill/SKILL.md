---
name: linksee-memory
description: |
  エージェントの「過去の自分」への橋。新しい作業・ファイル編集・意思決定・失敗の前後で、linksee-memory から過去の caveat（痛みの記録）/ learning（成長ログ）/ implementation（成功失敗）を recall する。
  これは Claude Code の「毎セッション記憶喪失」問題を解決する唯一の方法。Mem0/Letta/Zep にはできない「同じ失敗を二度としない」仕組み。
  以下のタイミングで必ずこのスキルを使うこと：
  ①作業開始時・新タスク開始時（「実装しよう」「始めよう」「新しく〜作る」）
  ②ファイル編集する前（同じファイルを過去に触ってる可能性がある）
  ③エラー・失敗した瞬間（remember で caveat 記録）
  ④成功した瞬間・新しいこと学んだ瞬間（remember で learning 記録）
  ⑤ユーザーが「前に」「同じ」「覚えてる？」「覚えておいて」と言ったとき
  ⑥「なぜそうした」「いつ決めた」「どこで議論した」と聞かれたとき
  ⑦別プロジェクトから戻ってきたとき・セッション切り替え時
  トリガー: 記憶/覚えて/忘れて/過去/前回/前に/そういえば/覚えてる/memory/remember/recall/forget
  エラーキーワード: 失敗/エラー/うまくいかない/ハマった/同じ/また/繰り返し/debug
  決定キーワード: 決めた/方針/戦略/ピボット/やめよう/方向転換
---

# Linksee Memory Skill — エージェントの過去と未来をつなぐ

## 🧠 Core Principle

**このスキルは「エージェントの成長が session を跨いで永続するための唯一の手段」**。

Claude Code は session が終わると全部忘れる。Michieさんが昨日教えてくれた解決策、今日やった失敗、3日前の決定——すべて普通は消える。**linksee-memory は「消えない記憶」を作る装置**。

書き込みは Stop hook が自動でやってくれる（もう動いてる）。でも**読み出しはエージェントが能動的にやらないと使われない**。この skill がその「読みにいく習慣」をエージェントに植え付ける。

---

## 📐 6レイヤーの役割分担

どのレイヤーに記録するかで、後の検索精度が変わる。

| レイヤー | いつ使うか | 例 |
|---|---|---|
| 🎯 `goal` | ユーザーが明確なゴールを言ったとき | "freeeと連携させたい" "npm publishしたい" |
| 📍 `context` | いつ・なぜそれをしてるかの背景 | "X社との商談が水曜にあるから" |
| 💭 `emotion` | ユーザーの温度感・感情 | "疲れた" "嬉しい" "焦ってる" |
| 🔧 `implementation` | コードを書いた、設定した、動いた/動かなかった | 成功: "OAuth flow が通った" / 失敗: "auth_expired で止まった" |
| ⚠️ `caveat` | **二度と繰り返したくない教訓**（忘却保護） | "freeeのOAuthは24hで切れる" "このファイルは絶対編集しない" |
| 📈 `learning` | 新しいこと学んだ、前の考えが更新された | "AST chunking の方が line diff より効く" |

**重要:** `caveat` は自動で忘却保護される。痛みの記録は絶対消えない。

**v0.1.0: 別のpin方法** — `importance: 1.0` で remember すれば、caveat層じゃなくても auto-forget から保護される。「絶対忘れさせたくない goal」「重要な判断」等で使う:

```
remember({
  entity_name: "KanseiLink", entity_kind: "project",
  layer: "goal", content: "Plugin Marketplace 申請中",
  importance: 1.0  // pin
})
```

**Layer alias 対応** — canonical layer 名覚えなくても、自然な言い方で呼べる:

| 自然語 | → canonical |
|---|---|
| `decisions` / `insights` / `learned` | `learning` |
| `warnings` / `rules` / `pitfalls` / `dont` | `caveat` |
| `how` / `tried` / `attempts` / `success` / `failure` | `implementation` |
| `why` / `intent` / `goals` / `targets` | `goal` |
| `background` / `reason` / `situation` / `timing` | `context` |
| `tone` / `feelings` / `mood` | `emotion` |

---

## 🔄 実行フロー（5つのタイミング）

### ① Task Start — 作業開始前に必ず recall

新しい作業を始める**前**に、過去のコンテキストを注入する。

**v0.1.0 新フロー: 超-セッション冒頭は `list_entities` から**

会話の一番最初（ユーザーが最初の発話をしてきた時点）で、「自分が何を知ってるか」を把握する:

```
mcp__linksee__list_entities({ min_memories: 5, limit: 10 })
```

これで返ってくる "momentum 高い entity" = 今まさに話題に上りそうなプロジェクト。各entityの `layer_breakdown` を見れば「このprojectはcaveatが多い」「goalが未完」等が分かる。

その後、具体的な作業が始まったら recall:

```
mcp__linksee__recall({
  query: "<現タスクのキーワード。プロジェクト名 + 技術名>",
  max_tokens: 2000
})
```

**例**: ユーザーが「KanseiLinkに新しいツール追加したい」と言ったら：
```
recall({ query: "KanseiLink new tool", max_tokens: 2000 })
```

返ってきた memories から、特に以下に注目：
- **`caveat` 層** — 絶対避けるべき罠
- **`learning` 層** — 前に得た結論
- **`implementation.failure`** — 過去の失敗パターン

**例の結果の使い方:**
```
過去の caveat から: "同じMCPのtool名の衝突に気をつけろ"
→ 新しいツール追加前に既存tool名を確認する流れで作業開始
```

### ② File Edit — ファイル編集前に recall_file

特定ファイルを触る前に、そのファイルの過去の編集履歴を確認：

```
mcp__linksee__recall_file({
  path_substring: "<ファイルのパス or 部分一致する名前>",
  max_intents: 5
})
```

返ってくる: そのファイルの全編集履歴 + **各編集を引き起こしたユーザー発言**

**これがキモ**: Mem0/Lettaにはない機能。「このファイル、前になぜ変更されたか」が残ってる。

### ③ Before Reading — 既読ファイルなら read_smart

ファイルを読む必要があるとき、**Read ツールの代わりに read_smart を使う**:

```
mcp__linksee__read_smart({
  path: "<絶対パス>"
})
```

**効果**:
- 初回読み: 通常 Read と同じトークン（chunk metadata 付き）
- 2回目以降・変更なし: **~50 トークンだけ返る**（99% 節約）
- 2回目以降・変更あり: 変更 chunk だけ返る（50-90% 節約）

特に大きなファイル（1000行超えるもの）で効果絶大。

### ③.5 Updating existing memory — v0.1.0 新: forget+remember の代わりに update_memory

事実が変わった / 目標が更新された / caveat の細部を修正したい場合、**forget して remember すると memory_id が変わって session_file_edits のリンクが切れる**。代わりに `update_memory`:

```
update_memory({
  memory_id: 1234,
  content: '{"primary": "Plugin Marketplace 申請中(審査7日目)", "deadline": "2026-04-25"}',
  importance: 1.0  // pin 強化
})
```

`layer` も変更可能だが、caveat → 他への demotion は不可(auto-protectedのため)。

### ④ Failure — エラー発生時に caveat 記録

エラー・失敗・「うまくいかない」が発生した瞬間、すぐ記録する：

```
mcp__linksee__remember({
  entity_name: "<プロジェクト名 or サービス名>",
  entity_kind: "project",
  layer: "caveat",
  content: '{"rule_or_warning":"<失敗内容 + 回避策>","when":"<ISO日時>"}',
  importance: 0.8  // 失敗は重要度高め
})
```

**例**:
```json
{
  "rule_or_warning": "freee MCPは24時間でOAuth token切れる。refresh_token使って再取得する必要あり。access_tokenを直接使い回すと401で止まる",
  "from_incident": "session 02759-...で auth_expired エラー",
  "workaround": "24h毎に refresh token → 新しい access token"
}
```

**なぜ重要か**: `caveat` は**自動で忘却保護**される。この記録があれば、別セッションの別エージェントも同じ失敗を避けられる。

### ⑤ Success/Learning — 成功・学習時に記録

新しいこと理解した、アプローチ変えた、問題解決した瞬間：

```
mcp__linksee__remember({
  entity_name: "<entity>",
  entity_kind: "project | concept | ...",
  layer: "learning",
  content: '{"at":"<日時>","learned":"<何を学んだか>","prior_belief":"<前はこう思ってた>"}',
  importance: 0.7
})
```

`prior_belief` を書くことで「**信念の更新履歴**」が残る。これは後で「なぜこの決定をしたのか」の根拠になる。

---

## 🎯 絶対ルール

### ✅ やるべきこと

1. **新タスク開始時、必ず最初に `recall` を呼ぶ**（たとえ短くても）
2. **同じファイルを触る前に `recall_file` で過去履歴を確認**
3. **大きなファイルは `Read` より `read_smart` を優先**
4. **エラーが出たら即座に `caveat` 記録**（その場で記録、後回しにしない）
5. **ユーザーが驚いたり「なるほど」と言ったら `learning` 記録**

### ❌ やってはいけないこと

1. ❌ 作業開始時に recall せず、いきなり手を動かす
2. ❌ エラーをその場で解決したのに記録しない → 未来の自分（or 他のエージェント）が同じ失敗を繰り返す
3. ❌ `Read` ばかり使って `read_smart` を使わない（トークン無駄）
4. ❌ caveat をふざけた軽い tone で書く（真面目に残す）
5. ❌ 長期作業中は consolidate を忘れない（週1は `consolidate()` 呼ぶべき）

---

## 🔁 Consolidate — 記憶の定期整理

メモリが膨張してきたら（目安: DB 20MB超、memories 15,000件超）：

```
mcp__linksee__consolidate({
  scope: "session",
  min_age_days: 7
})
```

これで 7日前より古く、importance低く、cold バンドになった memories が自動でクラスタ化 → learning 層に1件に圧縮 → 元データ削除。

**caveat と active goal は消えない**。睡眠中の脳の記憶整理と同じ。

---

## 🧭 Skill 発火シナリオ集

### Case A: 新しいプロジェクトに入る

ユーザー: "今日は XYZ プロジェクトに戻るよ"

```
1. recall({ query: "XYZ", max_tokens: 2500 })
2. 返ってきた caveat/learning/goal を確認
3. ユーザーに「前回の続きで...」と状況を1行で示す
4. その文脈の上で作業開始
```

### Case B: 同じエラーが出た（デジャブ感）

ユーザー: "あれ、このエラー前も見たような..."

```
1. recall({ query: "<エラーメッセージの核キーワード>", max_tokens: 1000 })
2. 過去の caveat から workaround 取得
3. 「前回（日時）同じエラーで、X で解決した」と回答
4. workaround を適用
```

### Case C: ファイル編集前の確認

ユーザー: "server.ts を直して"

```
1. recall_file({ path_substring: "server.ts" })
2. 過去の編集頻度・理由を確認
3. 「このファイル過去 N 回編集されてる。最後は ○○ 目的」と報告
4. その文脈で今回の編集を行う
5. 編集後、implementation.success / failure で記録
```

### Case D: 決定した瞬間

ユーザー: "じゃあ Sonnet に切り替えるわ"

```
1. remember({
     entity_name: "<プロジェクト>",
     entity_kind: "project",
     layer: "learning",
     content: '{"at":"...", "learned":"このプロジェクトは Sonnet で行く", "prior_belief":"Opus使ってた"}',
     importance: 0.8
   })
2. 「記録しました」と一言
3. 次からの作業は Sonnet 前提で進める
```

### Case E: 長時間作業の終盤

ユーザー: "今日はここまで"

```
1. 今日のハイライトを remember で記録:
   - 主要な decision を learning 層
   - 発生した失敗を caveat 層
   - 完成した成果物を implementation.success
2. 「記録完了。次回 recall で取れる状態です」と報告
3. 必要なら consolidate({scope:"session", min_age_days: 14}) を提案
```

### Case F: ユーザーが「覚えて」と明示

ユーザー: "これは覚えておいて: cloudsign より DocuSign の方が安定"

```
1. remember({
     entity_name: "cloudsign vs DocuSign",
     entity_kind: "concept",
     layer: "caveat",
     content: '{"rule_or_warning":"cloudsign (61% success) より DocuSign-JP (100%) の方が安定。カスタマーに提案するときは DocuSign 推奨"}',
     importance: 0.9  // ユーザー明示指示は高優先度
   })
2. 「記憶しました。caveat 層なので忘れません」と確認
```

---

## 🔐 プライバシー（ユーザーに聞かれたとき）

linksee-memory は **完全ローカル**:
- DB: `~/.linksee-memory/memory.db` （ユーザーのPC内）
- 外部送信: なし（telemetry は opt-in、デフォルト OFF）
- バックアップ: ファイルコピーで完結

「私たちのデータは外に出てる？」と聞かれたら：
「**デフォルトで一切出てません。** telemetry を明示的に enable していない限り、すべてローカルDB。`~/.linksee-memory/memory.db` のコピーが唯一のバックアップ。」と答える。

---

## 🚀 KanseiLink Skill との連携

KanseiLink skill と linksee-memory skill は**セットで動く**と最大効果：

```
ユーザー: "freeeで請求書作って"
↓
[linksee-memory skill 発火] recall({query: "freee"})
  → 過去の caveat: "company_id 最初に取る必要あり"
  → 過去の learning: "OAuth 24h refresh"
↓
[kansei-link skill 発火] search_services({intent: "invoice"})
  → freee verified、trust 0.9
  → get_service_tips で pitfall 確認
↓
両方の集合知を持った状態で実装開始
```

**KanseiLink = 外部SaaSの集合知 / linksee-memory = 自分の過去の集合知**。両輪。

---

## 📊 使うほど精度が上がる原理

| 時点 | recall 精度 | なぜ |
|---|---|---|
| Day 1 | 低（データ少） | Stop hook が貯めてる最中 |
| Week 1 | 中 | 数千件 memories、FTS5 が効き出す |
| Month 1 | 高 | heat_score が安定、重要メモリが浮上 |
| Month 3+ | 最強 | consolidate 走って、learnings が結晶化 |

**「使うほど賢くなる」は時間が味方してくれる**。今日の記録は 3ヶ月後の自分が読む。

---

*このスキルは linksee-memory MCP v0.0.5+ の上で動く。*
*Stop hook 経由で自動記録、recall 経由で手動取り出し。*
*MCP Registry 登録済み、Glama/LobeHub 申請中（2026-04-17 時点）*
*MIT License — Synapse Arrows PTE. LTD.*
