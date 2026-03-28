# PulSeed品質引き上げロードマップ — roadmapが期待するクオリティへ

**作成日**: 2026-03-15
**前提**: Stage 1-14 完了、2844テスト、65テストファイル、Milestone 1-2 完了

---

## 現状の正直な評価

### 動くもの

- **型システムとスキーマ**: 29 Zodスキーマファイル、堅牢な型定義
- **個別モジュールの単体テスト**: 2844テストが通過。GapCalculator、DriveScorer、SatisficingJudge、StallDetector等はそれぞれ単体では正しく動く
- **DataSource経由の機械的観測**: FileExistenceDataSource、GitHubIssueDataSource等はファイル存在・issue数の数値を正しく返す
- **状態永続化**: StateManagerのファイルベースJSON永続化は安定

### 動かないもの（致命的）

- **CoreLoopが「完了」を即座に宣言する**: `runOneIteration()` の Step 5（Completion Check、L620-638）がStep 7（Task Cycle、L838）より前にある。全次元が閾値以上（たとえギリギリでも）なら `judgment.is_complete = true` → `return result` でタスク生成に到達しない。つまり**PulSeedは何もしない**
- **LLM観測がコンテキストなしで評価する**: `observeWithLLM()` はゴール説明・次元ラベル・閾値だけをLLMに渡す。ワークスペースのファイル内容を一切読まない。`contextProvider` はDI引数として存在するが、CLI起動時に適切な実装が注入されていない
- **タスク生成→実行→検証の一気通貫が未検証**: `TaskLifecycle.runTaskCycle()` → adapter.execute() → verifyTask() のパスは単体テストでモックされているが、実際のLLM呼び出し＋実際のアダプタ実行で動いた実績がない

### 見せかけのもの（テストは通るが実質機能しない）

- **Milestone 2のE2Eテスト**: モックLLM・モックアダプタで「ループが完走する」ことを確認しているが、実際のLLM呼び出しでは検証されていない。テストが通る＝本番で動く、ではない
- **ゴール交渉**: DataSource次元名の強制が軽減された（commit eab1bdf + 1bcb8db で閾値 0.3→0.6、プロンプト軟化）が、完全な改善にはまだ遠い。品質次元が依然としてDataSource次元にすり替わるリスク
  - 注: `CRITICAL CONSTRAINT` の強制は緩和されたが、30%トークンオーバーラップで強制リネームの本質的問題は残る
  - R3-4 で警告メッセージ実装がまだ
- **自動アーカイブ**: CoreLoopが「完了」と判定した瞬間にゴール状態をアーカイブに移動する。以降 `loadGoal()` が `null` を返すため、デバッグ・再実行が不可能になる
  - **部分改善**: `loadGoal()` アーカイブフォールバック実装がまだ（R1-3 bug #6）

---

## Phase R1: CoreLoopを「動く」状態にする ✅ 完了

**目的**: observe → gap → score → task → execute → verify サイクルが最低1回は完走すること。

### R1-1: Satisficing短絡の修正 ✅ 完了

**問題**: `core-loop.ts` L620-638。Step 5 Completion CheckでStep 7 Task Cycleより前に `return` している。

**修正方針**: Completion Checkをタスクサイクルの後に移動する。現在の順序:
```
Step 5: Completion Check → is_complete なら return（タスク生成なし）
Step 6: Stall Check
Step 7: Task Cycle
```
修正後:
```
Step 5: (削除 or フラグ化)
Step 6: Stall Check
Step 7: Task Cycle
Step 8: Completion Check（タスク実行後に判定）
```

ただし「本当に完了しているゴール」では無駄なタスクを生成しないよう、completion判定を2段階にする:
1. **強い完了**: 全次元が閾値の110%以上 → タスク生成せず完了（現行動作を維持）
2. **弱い完了**: 全次元が閾値以上だが110%未満 → タスクを1回生成して実行し、改善余地があるか確認してから完了判定

**ファイル**: `src/core-loop.ts` (L620-638, L838-930付近)、`src/satisficing-judge.ts`

**成功基準**: 閾値ギリギリのゴール（例: 全次元 current_value = threshold + 0.01）に対してタスクが1つ以上生成される

**複雑度**: M

**依存**: なし（最優先で着手）

### R1-2: ループの最低1回実行保証 ✅ 完了

**問題**: 初回ループでも即座に完了判定される可能性がある（ゴール作成時に初期値が閾値以上の場合）。

**修正方針**: CoreLoopに `minIterations` 設定（デフォルト: 1）を追加。最低N回はタスクサイクルを実行してからcompletion判定を行う。

**ファイル**: `src/core-loop.ts`（CoreLoopConfig型 + run()メソッド）

**成功基準**: `minIterations: 1` の場合、ゴール状態に関係なく最低1回のタスクサイクルが実行される

**複雑度**: S

**依存**: R1-1

### R1-3: 完了→アーカイブの即時実行を防止 ✅ 完了

**問題**: `core-loop.ts` L397付近。`finalStatus === "completed"` の直後に `archiveGoal()` が呼ばれ、ゴール状態が消える。

**修正方針**:
- 完了後の自動アーカイブをデフォルトOFFにする（設定 `autoArchive: false`）
- アーカイブは明示的な `pulseed goal archive <id>` コマンドでのみ実行
- `loadGoal()` にアーカイブフォールバック追加（`goals/` になければ `archive/` も探す）

**ファイル**: `src/core-loop.ts`（autoArchive設定）、`src/state-manager.ts`（loadGoalフォールバック）

**成功基準**: ループ完了後も `pulseed goal show <id>` でゴール状態が表示される

**複雑度**: S

**依存**: なし

**修正状態**:
- 自動アーカイブ機能は実装済み（CoreLoopで `archiveGoal()` 呼び出し）
- ✅ アーカイブフォールバック (`loadGoal()` が archive/ も探す) — 実装完了

### R1 検証方法

手動テスト:
```bash
# 明らかに未達成のゴール（存在しないファイルを要求）
pulseed goal add "Create a file called /tmp/pulseed-test-output.txt with 'hello world'"
pulseed run --goal <id> --yes --max-iterations 3
# 期待: タスクが1つ以上生成され、アダプタに実行が委譲される
```

自動テスト: `tests/e2e/r1-core-loop-executes.test.ts` を新規作成。モックアダプタでタスクサイクル到達を検証。

---

## Phase R2: LLM観測の実質化

**目的**: LLM観測が実際のワークスペース内容を読み、スコアが現実を反映すること。

**依存**: R1が完了していなくても並行着手可能（観測の改善は独立）

### R2-1: contextProviderのゴール認識型ファイル選択 ✅ 完了

**問題**: `observation-engine.ts` L67-78。`contextProvider` はDI引数だが、CLI起動時（`cli-runner.ts`）で注入される実装が貧弱（5ファイル固定 x 2000文字切り詰め）か、そもそも未注入。

**修正方針**:
- `contextProvider` のシグネチャを `(goalId: string, dimensionName: string) => Promise<string>` に拡張（次元ごとに異なるファイルを読めるように）
- デフォルト実装を `src/context-providers/workspace-context.ts` として新規作成:
  1. ゴールの `description` と次元の `label` からキーワードを抽出
  2. キーワードに基づいてワークスペース内のファイルを検索（ファイル名マッチ → grepマッチ）
  3. 上位5ファイルの内容を各4000文字まで読み込み
  4. 読み込んだ内容をコンテキスト文字列として返す
- `cli-runner.ts` でこのデフォルト実装を注入

**ファイル**: `src/observation-engine.ts`（contextProviderシグネチャ変更）、`src/context-providers/workspace-context.ts`（新規）、`src/cli-runner.ts`（注入）

**成功基準**: `README品質` 次元の観測で、実際のREADME.mdの内容がLLMに渡される

**複雑度**: M

**修正状態**:
- contextProviderシグネチャを `(goalId: string, dimensionName: string) => Promise<string>` に拡張
- `src/context-providers/workspace-context.ts` 新規作成: キーワード抽出 → ファイル名/内容マッチ → 上位5ファイル×4000文字
- `src/cli-runner.ts` でゴール認識型provider注入
- テスト: `tests/observation-engine-context.test.ts` 9テスト通過

### R2-2: observeWithLLMへのファイル内容注入 ✅ 完了

**問題**: `observation-engine.ts` L530付近。`observeWithLLM()` のプロンプトにワークスペース内容が含まれない（bug analysis #4で確認済み）。

**修正方針**:
- `observeWithLLM()` のプロンプトを拡張:
  ```
  以下のゴールの次元を0.0〜1.0で評価してください。
  ゴール: ${goalDescription}
  評価次元: ${dimensionLabel}
  目標値: ${thresholdDescription}

  === 現在のワークスペース状態 ===
  ${workspaceContext}

  === 前回の観測結果 ===
  前回スコア: ${previousScore ?? "なし"}

  上記の実際のファイル内容に基づいて評価してください。
  ```
- `workspaceContext` は R2-1のcontextProviderから取得した文字列
- `previousScore` は `dim.current_value` を渡す

**ファイル**: `src/observation-engine.ts`（L492-540付近、observeWithLLMメソッド）

**成功基準**: LLMプロンプトにファイル内容が含まれ、ファイルを変更した後にスコアが変化する

**複雑度**: M

**修正状態**:
- observeWithLLMプロンプトに前回スコア（`前回の観測結果: スコア X.XX`）追加
- コンテキストセクションにゴール認識型ワークスペース内容を注入
- プロンプト末尾を「実際のファイル内容に基づいて評価」に改善
- テスト: previous score検証含む9テスト通過

### R2-3: observeCount切り詰めバグの修正 ✅ 修正済み

**問題**: `observation-engine.ts` L319。`methods` 配列が `goal.dimensions` より短い場合、残りの次元が観測されない（bug analysis #7）。

**修正方針**: `observeCount` を常に `goal.dimensions.length` にする。`methods[idx] ?? dim.observation_method` のフォールバックは既に実装済みなので、切り詰めを除去するだけ。

**ファイル**: `src/observation-engine.ts`（L319、1行修正）

**成功基準**: 5次元のゴールに対して2つのmethodsを渡しても、5次元すべてが観測される

**複雑度**: S

**修正内容**: commit eab1bdf で修正。`observe()` メソッドが `methods.length > 0 ? methods.length : goal.dimensions.length` で全次元を評価するように改善。

### R2 検証方法

手動テスト:
```bash
# README品質ゴールを作成
pulseed goal add "Improve README.md quality: add installation guide, usage examples, API reference"
pulseed run --goal <id> --yes --max-iterations 1
# 期待: 観測ログにREADME.mdの内容が含まれ、スコアが0.0-1.0の妥当な値
# README.mdを実際に編集した後に再実行 → スコアが変化する
```

自動テスト: `tests/observation-engine-context.test.ts` を新規作成。contextProviderがファイル内容を返し、observeWithLLMのプロンプトに反映されることを検証。

---

## Phase R3: タスク生成→実行→検証の一気通貫 ✅ 完了

**目的**: PulSeedが自律的に1つの具体的改善を完了すること。

**依存**: R1（ループが動くこと）、R2（観測が現実を反映すること）

### R3-1: タスク生成プロンプトの検証と改善 ✅ 完了

**問題**: `task-lifecycle.ts` L911-1003付近。`buildTaskGenerationPrompt()` が生成するプロンプトの品質が未検証。生成されたタスクが「具体的で実行可能か」の確認がない。

**修正方針**:
- タスク生成プロンプトに以下を追加:
  - 現在のワークスペース状態（どのファイルが存在し、何が不足しているか）
  - 対象次元の現在値と目標値の具体的な差
  - 過去に生成されたタスクとその結果（重複防止）
- プロンプトの末尾に出力形式の制約を強化:
  ```
  タスクのwork_descriptionには以下を含めること:
  1. 変更対象のファイルパス
  2. 具体的な変更内容（「改善する」ではなく「セクションXを追加する」）
  3. 完了判定基準
  ```

**ファイル**: `src/task-lifecycle.ts`（buildTaskGenerationPrompt、L911-1010付近）

**成功基準**: 生成されたタスクのwork_descriptionが具体的なファイルパスと変更内容を含む

**複雑度**: M

### R3-2: アダプタ実行の実証テスト ✅ 完了

**問題**: Claude Code CLIアダプタ（`src/adapters/claude-code-cli.ts`）とOpenAI Codexアダプタ（`src/adapters/openai-codex.ts`）が実際のタスクを実行できるか未検証。

**修正方針**:
- 統合テスト `tests/e2e/r3-adapter-execution.test.ts` を新規作成
- テストシナリオ: 「`/tmp/pulseed-test/` に `hello.txt` を作成する」タスクを実際のアダプタで実行
- Claude Code CLI / Codex のどちらか利用可能な方でテスト
- テスト後にファイル存在を確認

**ファイル**: `tests/e2e/r3-adapter-execution.test.ts`（新規）

**成功基準**: アダプタが実際にコマンドを実行し、ファイルが作成される

**複雑度**: M

### R3-3: タスク実行後の観測フィードバック検証 ✅ 完了

**問題**: タスク実行後に再観測しても、観測結果が変わらない可能性がある（R2のLLM観測改善が前提）。

**修正方針**:
- `verifyTask()` の `dimension_updates` が正しくゴール状態に反映されることを検証
- 反映後の再観測で、LLMが変更を検出してスコアを更新することを検証
- 「変更なし」の場合はstall detectionが発動することを検証

**ファイル**: `src/task-lifecycle.ts`（verifyTask周辺）、`tests/e2e/r3-feedback-loop.test.ts`（新規）

**成功基準**: タスク実行→ファイル変更→再観測でスコアが向上する一気通貫パスが動く

**複雑度**: L

### R3-4: ゴール交渉の次元品質改善 ✅ 完了

**問題**: `goal-negotiator.ts` L61-66。DataSource次元名の強制が品質次元を殺す（bug analysis #3）。

**修正方針**:
- プロンプトの `CRITICAL CONSTRAINT` / `MUST` を `PREFER` / `SHOULD` に軟化
- 「品質を直接測定する次元を最低2つ含めること」の指示を追加
- `findBestDimensionMatch()` のトークンオーバーラップ閾値を0.3→0.6に引き上げ
- 交渉結果のバリデーション: LLMが返した次元が全てDataSource次元のコピーなら警告を出す

**ファイル**: `src/goal-negotiator.ts`（L49-91 プロンプト、L399-424 リマッピング、L1207-1223 マッチング閾値）

**成功基準**: 「README品質改善」ゴールの交渉で、`readme_quality`、`example_completeness` 等の品質次元が生成される（DataSource次元だけにならない）

**複雑度**: M

**修正内容**:
- commit eab1bdf: 閾値を 0.3 → 0.6 に引き上げ
- commit 1bcb8db: プロンプト軟化（CRITICAL CONSTRAINTを軽減）、min-type例を追加
- ✅ 警告メッセージのバリデーション実装完了（全次元がDataSource次元にリマップされた場合にconsole.warn）

### R3 検証方法

手動テスト（最も重要な検証）:
```bash
# PulSeedに「LICENSEファイルを追加する」ゴールを与える
pulseed goal add "Add a LICENSE file (MIT) to the project root"
pulseed run --goal <id> --yes --max-iterations 3

# 期待される動作:
# 1. 観測: LICENSEファイルが存在しない → スコア 0.0
# 2. タスク生成: 「ルートにMIT LICENSEファイルを作成する」
# 3. アダプタ実行: 実際にLICENSEファイルが作成される
# 4. 再観測: LICENSEファイルが存在する → スコア 1.0
# 5. 完了判定: ゴール達成
```

---

## Phase R4: CLIの安定化

**目的**: `npm install -g pulseed && pulseed run` が動くこと。

**依存**: R1-R3と並行着手可能

### R4-1: エントリポイントの修正

**問題**: `package.json` の `bin` は `dist/cli-runner.js` を指しているが、実際にこのファイルが動くか未検証。`dist/index.js` はCLI起動用ではない（モジュールエクスポート用）。

**修正方針**:
- `dist/cli-runner.js` の先頭に `#!/usr/bin/env node` シバンがあることを確認
- ビルド後に `node dist/cli-runner.js --help` が動くことをCIで検証
- `npm link` で `pulseed` コマンドが使えることをテスト

**ファイル**: `src/cli-runner.ts`（シバン確認）、`package.json`（bin設定確認）、`.github/workflows/ci.yml`（ビルド後CLI動作テスト追加）

**成功基準**: `npm link && pulseed --help` が正常にヘルプテキストを表示する

**複雑度**: S

### R4-2: フラグ解析の修正

**問題**: `--yes` フラグが位置引数の前に来ると無視される。

**修正方針**:
- `cli-runner.ts` のフラグ解析ロジックを確認。`parseArgs` の `allowPositionals` 設定と組み合わせでフラグが消費されない問題を特定・修正
- 全サブコマンドで `--yes`, `--max-iterations`, `--adapter` フラグが位置に依存しないことを検証

**ファイル**: `src/cli-runner.ts`（parseArgs設定）

**成功基準**: `pulseed --yes run --goal <id>` と `pulseed run --goal <id> --yes` の両方が同じ動作をする

**複雑度**: S

### R4-3: file_existenceタイプのCLI対応 ✅ 修正済み

**問題**: `cli-runner.ts` L812-814。`datasource add` で `file_existence` タイプが拒否される（bug analysis #5）。

**修正方針**:
- 許可タイプリストに `file_existence` を追加
- `name` 導出ロジック（L833）に `file_existence` ブランチ追加
- ヘルプテキスト更新

**ファイル**: `src/cli-runner.ts`（L812, L833, L1538付近）

**成功基準**: `pulseed datasource add file_existence --path ./README.md` が成功する

**複雑度**: S

**修正内容**: commit eab1bdf で実装。`datasource add` で `file_existence` タイプが正常に受け入れられるように修正。

### R4-4: コマンド出力の改善

**問題**: 多くのコマンドが無出力で終了し、成功したのか失敗したのか分からない。

**修正方針**:
- 全サブコマンドの正常終了時に最低1行の確認メッセージを出力
- `pulseed run` 実行中のイテレーション進捗表示（`[Iteration 1/10] observing... gap=0.35, generating task...`）
- エラー時のメッセージ改善（スタックトレースではなく、何が起きたか・どうすればいいかを表示）

**ファイル**: `src/cli-runner.ts`（全サブコマンド）、`src/core-loop.ts`（進捗コールバック追加）

**成功基準**: 全サブコマンドが最低1行の出力を返す

**複雑度**: M

### R4-5: 環境変数バリデーションの早期実行 🔄 必要

**問題**: `provider-factory.ts`。LLMプロバイダのAPIキーが未設定でもコンストラクタは成功し、最初のLLM呼び出し時にようやくエラーになる（bug analysis #8）。

**修正方針**:
- `buildLLMClient()` 内でAPIキーの存在を即座に検証
- 未設定の場合は設定方法を含むエラーメッセージを表示:
  ```
  Error: OPENAI_API_KEY is not set.
  Set it via: export OPENAI_API_KEY=sk-...
  Or configure in ~/.pulseed/provider.json
  ```

**ファイル**: `src/provider-factory.ts`（L31-83）

**成功基準**: APIキー未設定で `pulseed run` を実行すると、即座に分かりやすいエラーが出る

**複雑度**: S

**修正状態**: 未実装（優先度中）

### R4 検証方法

```bash
npm run build
npm link
pulseed --help                    # ヘルプ表示
pulseed goal add "test goal"      # ゴール作成確認メッセージ
pulseed goal list                 # ゴール一覧表示
pulseed datasource add file_existence --path ./README.md  # 成功
pulseed --yes run --goal <id>     # フラグ位置非依存
```

---

## Phase R5: Dogfooding再実行

**目的**: R1-R4の修正後、PulSeedが実際にゴールを自律的に達成すること。

**依存**: R1, R2, R3 必須。R4 推奨。

### R5-1: 簡単なゴールでの検証

**ゴール**: 「プロジェクトルートに `CONTRIBUTING.md` を作成する（基本的な貢献ガイドライン）」

**検証項目**:
- [ ] ゴール交渉で妥当な次元が生成される（例: `file_exists`, `content_quality`）
- [ ] 観測で `CONTRIBUTING.md` の不在が検出される（スコア 0.0）
- [ ] タスクが生成される（「CONTRIBUTING.mdを作成する」）
- [ ] アダプタがタスクを実行する（ファイルが実際に作成される）
- [ ] 再観測でスコアが向上する
- [ ] ループが自然に完了するか、適切に停止する

**複雑度**: M（検証作業のみ）

### R5-2: npm publish品質ゴールの再実行

**ゴール**: Milestone 3の本来のゴール「npm publishできる状態にする」

**検証項目**:
- [ ] 品質次元が適切に生成される（`package_description`, `readme_install_guide`, `type_definitions` 等）
- [ ] 各次元のスコアが実態を反映する
- [ ] タスクが具体的（「package.jsonのdescriptionフィールドを設定する」等）
- [ ] 少なくとも1つのタスクが実行され、改善が観測される
- [ ] 不必要なタスク重複（dedup）が防止される

**複雑度**: L（本番に近い複雑度）

### R5-3: 結果の文書化

**出力**: `docs/dogfooding-r5-results.md` に以下を記録:
- 各ゴールの実行ログ（イテレーション数、生成タスク、観測スコア推移）
- 動いたもの、動かなかったもの
- 次のフェーズで修正すべき問題リスト

**複雑度**: S

---

## 全体依存関係図

```
R1 CoreLoop修正 ────────────────┐
                                 ├──→ R3 一気通貫 ──→ R5 Dogfooding
R2 LLM観測改善 ────────────────┘        │
                                         │
R4 CLI安定化 ──（並行可能）──────────────┘
```

- **R1とR2は並行着手可能**（異なるファイルが主対象）
- **R3はR1+R2の完了が前提**（ループが動き、観測が正しくないと検証できない）
- **R4は独立**（いつでも着手可能）
- **R5はR1+R2+R3の完了が前提**

## 工数見積もり

| Phase | タスク数 | S | M | L | 推定工数 |
|-------|---------|---|---|---|---------|
| R1 | 3 | 2 | 1 | 0 | 半日 |
| R2 | 3 | 1 | 2 | 0 | 1日 |
| R3 | 4 | 0 | 3 | 1 | 1.5日 |
| R4 | 5 | 3 | 1 | 1 | 1日 |
| R5 | 3 | 1 | 1 | 1 | 1日 |
| **合計** | **18** | **7** | **8** | **3** | **5日** |

## 変更ファイル一覧

| ファイル | Phase | 変更内容 |
|---------|-------|---------|
| `src/core-loop.ts` (1142行) | R1, R4 | Completion Check位置移動、minIterations、autoArchive、進捗出力 |
| `src/observation-engine.ts` (642行) | R2 | contextProviderシグネチャ拡張、observeWithLLMプロンプト改善、observeCount修正 |
| `src/context-providers/workspace-context.ts` | R2 | 新規: ゴール認識型ファイル選択 |
| `src/task-lifecycle.ts` (1237行) | R3 | タスク生成プロンプト改善 |
| `src/goal-negotiator.ts` (1251行) | R3 | DataSource次元強制の軟化、閾値引き上げ |
| `src/satisficing-judge.ts` (687行) | R1 | 強い完了/弱い完了の2段階判定 |
| `src/state-manager.ts` | R1 | loadGoalアーカイブフォールバック |
| `src/cli-runner.ts` (1674行) | R4 | file_existence対応、フラグ解析修正、出力改善 |
| `src/provider-factory.ts` | R4 | APIキー早期バリデーション |
| `tests/e2e/r1-*.test.ts` | R1 | 新規: CoreLoop実行テスト |
| `tests/e2e/r3-*.test.ts` | R3 | 新規: アダプタ実行・フィードバックループテスト |
| `tests/observation-engine-context.test.ts` | R2 | 新規: コンテキストプロバイダテスト |

---

## R5以降の展望

R5の結果次第で以下のいずれかに進む:

1. **R5成功（1つ以上のゴールを自律達成）**: 元のロードマップ Milestone 3 を正式に完了とし、Milestone 4（永続ランタイム）に進む
2. **R5部分成功（タスク生成まで動くが実行で失敗）**: アダプタ層の追加改善フェーズ（R3b）を挟む
3. **R5失敗（根本的な問題が残る）**: 問題を分析し、このロードマップ自体を更新する

重要なのは、**テストが通ることと本番で動くことは別物**だということを忘れないこと。R5のdogfoodingこそが真の検証であり、テスト追加はその補助に過ぎない。
