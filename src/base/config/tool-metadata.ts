// ─── Tool Metadata ───
//
// Rich metadata for config keys and mutation tools. Injected into LLM tool
// descriptions so the LLM can generate thorough explanations before acting.

// ─── Config Key Metadata (unchanged) ───

export interface ConfigKeyMeta {
  label: string;
  description: string;
  type: "boolean" | "number" | "string" | "object";
  effects: string[];
  requirements: string[];
  risks: string[];
  revert: string;
  appliesAt: "next_session" | "immediate";
  requiresExplicitApproval?: boolean;
}

export const CONFIG_METADATA: Record<string, ConfigKeyMeta> = {
  daemon_mode: {
    label: "Daemon Mode",
    description: "CoreLoopをバックグラウンドdaemonとして実行するモード",
    type: "boolean",
    effects: [
      "CoreLoopがバックグラウンドdaemonプロセスとして常時動作する",
      "TUIを閉じてもゴールの実行が継続する",
      "TUIは「ウィンドウ」として何度でも再接続可能になる",
      "複数クライアント（TUIや通知チャネル）が同時にダエモンを監視できる",
    ],
    requirements: [
      "常時起動のPC（スリープしないこと）",
      "ポート41700が空いていること",
      "エージェント専用PCでの使用を推奨",
    ],
    risks: [
      "バックグラウンドでLLM APIを呼び続けるため、APIコストが継続的に発生する",
      "停止は pulseed daemon stop で明示的に行う必要がある",
      "PCがスリープするとdaemonも停止し、再起動が必要",
    ],
    revert: "pulseed config set daemon_mode false、または TUI内で /settings からOFFに切り替え",
    appliesAt: "next_session",
    requiresExplicitApproval: true,
  },
  no_flicker: {
    label: "No Flicker UI",
    description: "TUIの描画更新を抑えて端末のちらつきを減らす表示設定",
    type: "boolean",
    effects: [
      "TUIの描画挙動が変わる",
      "端末によってはちらつきが減る",
    ],
    requirements: [
      "TUIセッションで使用すること",
    ],
    risks: [
      "端末によっては体感差がない場合がある",
    ],
    revert: "pulseed config set no_flicker false",
    appliesAt: "immediate",
    requiresExplicitApproval: false,
  },
  interactive_automation: {
    label: "Interactive Automation",
    description: "Desktop, browser, and research automation provider settings",
    type: "object",
    effects: [
      "PulSeed can route selected tasks to configured desktop, browser, and research automation providers",
      "Desktop and browser mutation tools can interact with local or remote user interfaces",
      "Research tools can call a configured research provider for sourced answers",
    ],
    requirements: [
      "Provider credentials or host bridges must be configured before non-noop providers become available",
      "Desktop providers may require local app accessibility permissions",
    ],
    risks: [
      "Misconfigured GUI automation can click, type, or submit data in the wrong application",
      "Remote research or browser providers may send task content to third-party services",
    ],
    revert: "pulseed config set interactive_automation '{\"enabled\":false}'",
    appliesAt: "next_session",
    requiresExplicitApproval: true,
  },
};

export function configChangeRequiresApproval(key: string): boolean {
  return CONFIG_METADATA[key]?.requiresExplicitApproval ?? false;
}

/** Build a rich description string for a single config key. */
export function buildConfigKeyDescription(key: string): string {
  const m = CONFIG_METADATA[key];
  if (!m) return `Unknown config key: ${key}`;
  const bullet = (arr: string[]) => arr.map(s => `- ${s}`).join("\n");
  const timing = m.appliesAt === "next_session" ? "次のセッション（再起動後）から適用" : "即座に適用";
  const approval = m.requiresExplicitApproval ? "明示的なユーザー確認が必要" : "通常は即時変更してよい";
  return [`## ${m.label} (${key})`, m.description, "", "### 効果", bullet(m.effects), "",
    "### 必要な環境", bullet(m.requirements), "", "### リスク", bullet(m.risks), "",
    "### 元に戻す方法", m.revert, "", "### 適用タイミング", timing, "",
    "### 承認要件", approval].join("\n");
}

/** Build the full tool description with all config keys' metadata injected. */
export function buildConfigToolDescription(): string {
  const descs = Object.keys(CONFIG_METADATA).map(k => buildConfigKeyDescription(k)).join("\n\n---\n\n");
  return ["PulSeedの設定を変更する。", "",
    "【重要ルール】このツールを呼ぶ前に、以下を守ること：",
    "1. 変更する設定の『効果』『必要な環境』『リスク』『元に戻す方法』『適用タイミング』を説明する",
    "2. 承認要件が『明示的なユーザー確認が必要』の設定では、同意を得てから呼び出す",
    "3. 低リスク設定は簡潔に説明したうえで、そのまま実行してよい",
    "4. ランタイムが追加の承認を要求した場合はそれに従う", "",
    "【利用可能な設定キー】", "", descs].join("\n");
}

// ─── Mutation Tool Metadata (generic) ───

export interface MutationToolMeta {
  label: string;
  description: string;
  effects: string[];
  risks: string[];
  revert: string;
}

export const MUTATION_TOOL_METADATA: Record<string, MutationToolMeta> = {
  delete_goal: {
    label: "Delete Goal",
    description: "Permanently removes a goal and all associated state (observations, trust scores, session history)",
    effects: [
      "Goal and all children are permanently deleted",
      "Active agent sessions for this goal are terminated",
      "If daemon is running, the goal is removed from the active loop immediately",
      "Historical observation data is lost",
    ],
    risks: [
      "Cannot be undone — goal ID cannot be reused",
      "If the goal has running sessions, they will be force-terminated",
      "Child goals are also deleted recursively",
    ],
    revert: "Goal must be re-created manually with set_goal. Historical data cannot be recovered.",
  },
};

/** Build a rich description string for a mutation tool. */
export function buildMutationToolDescription(toolName: string): string {
  const m = MUTATION_TOOL_METADATA[toolName];
  if (!m) return `Unknown mutation tool: ${toolName}`;
  const bullet = (arr: string[]) => arr.map(s => `- ${s}`).join("\n");
  return [
    `## ${m.label}`,
    m.description, "",
    "重要: このツールを呼び出す前に、必ず以下を行ってください:",
    "1. 削除・影響の対象を具体的に説明する",
    "2. リスクを一覧で提示する",
    "3. この操作は元に戻せないことを明示する",
    "4. ユーザーの明示的な確認を得る",
    "ユーザーが確認するまでこのツールを呼び出さないでください。", "",
    "### 影響", bullet(m.effects), "",
    "### リスク", bullet(m.risks), "",
    "### 復元", m.revert,
  ].join("\n");
}
