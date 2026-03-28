# src/ ディレクトリ リストラクチャリング計画

## 背景

src/ 直下に48個のTypeScriptファイルがフラットに配置されている。プロジェクトの成長に伴い、ドメインごとのフォルダ分けで見通しを改善する。

## 現状

- src/ 直下: 48ファイル (27,423行)
- 既存サブフォルダ: adapters/, context-providers/, tui/, types/ (変更なし)
- テストファイル: 103ファイル (tests/ 直下、フラット)

## 提案するフォルダ構成

### src/llm/ — LLMクライアント群 (6ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| llm-client.ts | 315 | ILLMClient インターフェース + Anthropic実装 |
| openai-client.ts | 136 | OpenAILLMClient |
| codex-llm-client.ts | 92 | CodexLLMClient |
| ollama-client.ts | 78 | OllamaLLMClient |
| provider-factory.ts | 249 | buildLLMClient + buildAdapterRegistry |
| provider-config.ts | 140 | プロバイダ設定読み書き |

### src/runtime/ — プロセス基盤 (5ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| daemon-runner.ts | 155 | デーモンプロセス管理 |
| pid-manager.ts | 208 | PIDファイル管理 |
| logger.ts | 150 | ロガー |
| event-server.ts | 302 | HTTPイベントサーバー |
| notification-dispatcher.ts | 160 | 通知配信 |

### src/drive/ — モチベーション計算エンジン (5ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| drive-scorer.ts | 402 | ドライブスコア計算 |
| drive-system.ts | 375 | ドライブシステム |
| gap-calculator.ts | 364 | ギャップ計算 (5閾値型) |
| satisficing-judge.ts | 725 | 満足化判定 |
| stall-detector.ts | 440 | ストール検出 |

### src/traits/ — エージェント特性 (4ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| ethics-gate.ts | 680 | 倫理ゲート |
| trust-manager.ts | 453 | 信頼スコア管理 |
| curiosity-engine.ts | 974 | 好奇心エンジン |
| character-config.ts | 308 | キャラクター設定 |

### src/observation/ — 外界センシング (5ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| observation-engine.ts | 908 | 観測エンジン (LLM/DataSource/self-report) |
| data-source-adapter.ts | 70 | IDataSourceAdapter + DataSourceRegistry |
| context-provider.ts | 75 | buildWorkspaceContext |
| capability-detector.ts | 736 | 能力検出・調達 |
| workspace-context.ts | - | context-providers/ から移動 |

注: src/context-providers/ は廃止し、workspace-context.ts をここに統合。

### src/execution/ — タスク実行 (3ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| task-lifecycle.ts | 1461 | タスク全ライフサイクル |
| session-manager.ts | 583 | セッション管理 |
| adapter-layer.ts | 320 | アダプタ抽象化レイヤー |

### src/strategy/ — 戦略選択・ポートフォリオ (4ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| strategy-manager.ts | 790 | 戦略選択・実行 |
| strategy-template-registry.ts | 273 | 戦略テンプレート |
| portfolio-manager.ts | 847 | ポートフォリオ管理 |
| cross-goal-portfolio.ts | 944 | ゴール横断ポートフォリオ |

### src/goal/ — ゴール管理 (5ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| goal-negotiator.ts | 1446 | ゴール交渉 |
| goal-tree-manager.ts | 1181 | ゴールツリー管理 |
| goal-dependency-graph.ts | 239 | ゴール依存グラフ |
| state-aggregator.ts | 130 | 状態集約 |
| tree-loop-orchestrator.ts | 125 | ツリーレベルループ |

### src/knowledge/ — 知識管理 (7ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| knowledge-manager.ts | 743 | 知識マネージャ |
| knowledge-graph.ts | 206 | 知識グラフ |
| knowledge-transfer.ts | 654 | 知識転送 |
| learning-pipeline.ts | 1032 | 学習パイプライン |
| memory-lifecycle.ts | 1954 | メモリライフサイクル |
| embedding-client.ts | 162 | 埋め込みクライアント |
| vector-index.ts | 244 | ベクトルインデックス |

### src/ (ルート) — エントリポイント (5ファイル)
| ファイル | 行数 | 説明 |
|---------|------|------|
| core-loop.ts | 1395 | コアオーケストレーションループ |
| cli-runner.ts | 2652 | CLIエントリポイント |
| reporting-engine.ts | 593 | レポート生成 |
| state-manager.ts | 431 | ファイルベース状態永続化 |
| index.ts | 60 | パッケージエントリポイント |

## 移行計画

### 原則
- 1バッチ = 1-2フォルダ移動 + import全書き換え + テスト全パス確認
- テストファイル(tests/)はフラットのまま維持（後日別タスクで整理）
- 各バッチで `npm run build && npx vitest run` が通ることを確認してからコミット
- `src/index.ts` の re-export はバッチごとに更新

### Batch 1: src/llm/ + src/runtime/ (11ファイル)
- 外部依存最少、低リスク
- provider-factory のみ cli-runner/core-loop から参照される
- 推定影響: import書き換え ~20箇所

### Batch 2: src/drive/ + src/traits/ (9ファイル)
- 純粋計算モジュール、インターフェース境界が明確
- core-loop, task-lifecycle, cli-runner から参照
- 推定影響: import書き換え ~30箇所

### Batch 3: src/observation/ + src/execution/ (8ファイル)
- context-providers/ を observation/ に統合
- 中程度の結合度
- 推定影響: import書き換え ~25箇所

### Batch 4: src/strategy/ + src/goal/ + src/knowledge/ (16ファイル)
- 高結合ドメイン、相互参照あり
- 最後に移行（他ドメインが安定してから）
- 推定影響: import書き換え ~50箇所

## 大ファイル分割計画 (Phase 2 — フォルダ移行完了後)

### cli-runner.ts (2652行) → src/cli/
- cli-runner.ts (~400行) — CLIRunner class shell + main()
- cli/commands/goal.ts (~500行) — goal add/list/archive/status
- cli/commands/run.ts (~400行) — pulseed run
- cli/commands/suggest.ts (~300行) — pulseed suggest/improve
- cli/commands/config.ts (~200行) — provider/datasource設定
- cli/commands/daemon.ts (~200行) — daemon start/stop/status
- cli/commands/report.ts (~150行) — レポート生成
- cli/setup.ts (~400行) — 依存構築 (buildDeps)

### memory-lifecycle.ts (1954行)
- memory-lifecycle.ts (~600行) — MemoryLifecycleManager core
- drive-score-adapter.ts (~200行) — DriveScoreAdapter
- memory-phases.ts (~600行) — Phase 1/2 helpers
- memory-persistence.ts (~400行) — File I/O, serialization

### task-lifecycle.ts (1461行)
- task-lifecycle.ts (~700行) — TaskLifecycle core
- task-health-check.ts (~300行) — post-execution health check
- task-prompt-builder.ts (~400行) — prompt construction

### goal-negotiator.ts (1446行)
- goal-negotiator.ts (~700行) — GoalNegotiator core
- goal-suggest.ts (~400行) — suggestGoals, filterSuggestions
- goal-validation.ts (~300行) — validation, capability gap check

## リスクと注意事項

1. **Import書き換えが最大リスク** — 48ソース + 103テストの相対パスを全更新。漏れ1つでビルド破損
2. **index.ts の re-export** — npm パッケージとして import している外部があれば壊れる
3. **循環依存の表面化** — ファイル移動で隠れていた循環importが顕在化する可能性あり
4. **テストファイルは移動しない** — tests/ のフラット構成は維持。import パスのみ更新
5. **context-providers/ 廃止** — workspace-context.ts を observation/ に移動後、空ディレクトリ削除
