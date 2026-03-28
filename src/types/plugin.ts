import { z } from "zod";

// ─── Config field schema ───

export const ConfigFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean", "array"]),
  required: z.boolean().default(false),
  default: z.unknown().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

export type ConfigField = z.infer<typeof ConfigFieldSchema>;

// ─── Plugin manifest schema ───

export const PluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "プラグイン名は小文字英数字とハイフンのみ"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  type: z.enum(["adapter", "data_source", "notifier"]),

  // 能力宣言（CapabilityDetectorが参照する）
  capabilities: z.array(z.string()).min(1),

  // data_sourceのみ: 観測可能な次元名リスト
  dimensions: z.array(z.string()).optional(),

  // notifierのみ: サポートするイベント種別
  supported_events: z.array(z.string()).optional(),

  description: z.string(),
  config_schema: z.record(ConfigFieldSchema).default({}),

  // npm依存パッケージ
  dependencies: z.array(z.string()).default([]),

  // プラグインのエントリポイント（plugin directoryからの相対パス）
  entry_point: z.string().default("dist/index.js"),

  // 必要なPulSeedのバージョン（semver range）
  min_pulseed_version: z.string().optional(),
  max_pulseed_version: z.string().optional(),

  // 宣言するリソースアクセス（セキュリティ審査用）
  permissions: z
    .object({
      network: z.boolean().default(false),
      file_read: z.boolean().default(false),
      file_write: z.boolean().default(false),
      shell: z.boolean().default(false),
    })
    .default({}),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export type PluginType = PluginManifest["type"];

// ─── Plugin state schema ───

export const PluginStateSchema = z.object({
  name: z.string(),
  manifest: PluginManifestSchema,
  status: z.enum(["loaded", "error", "disabled", "incompatible"]),
  error_message: z.string().optional(),
  loaded_at: z.string(), // ISO 8601
  // 信頼スコア（trust-and-safety.md §2 と同じ非対称設計）
  trust_score: z.number().int().min(-100).max(100).default(0),
  usage_count: z.number().int().default(0),
  success_count: z.number().int().default(0),
  failure_count: z.number().int().default(0),
});

export type PluginState = z.infer<typeof PluginStateSchema>;

// ─── Plugin match result ───

export const PluginMatchResultSchema = z.object({
  pluginName: z.string(),
  matchScore: z.number().min(0).max(1),
  matchedDimensions: z.array(z.string()),
  trustScore: z.number().int(),
  autoSelectable: z.boolean(), // trust_score >= 20
});

export type PluginMatchResult = z.infer<typeof PluginMatchResultSchema>;

// ─── Notification types ───

export type NotificationEventType =
  | "goal_progress" // ゴールの進捗更新
  | "goal_complete" // ゴール達成
  | "task_blocked" // タスクがブロックされた
  | "approval_needed" // 人間の承認が必要
  | "stall_detected" // 停滞が検知された
  | "trust_change"; // 信頼スコアが大きく変化した

export interface NotificationEvent {
  type: NotificationEventType;
  goal_id: string;
  timestamp: string; // ISO 8601
  summary: string; // 人間が読む1行サマリー
  details: Record<string, unknown>; // イベント種別固有のデータ
  severity: "info" | "warning" | "critical";
}

// ─── INotifier interface ───

export interface INotifier {
  name: string;
  notify(event: NotificationEvent): Promise<void>;
  supports(eventType: NotificationEventType): boolean;
}
