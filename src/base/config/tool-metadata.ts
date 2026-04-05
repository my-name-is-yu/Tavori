// ─── Tool Metadata ───
//
// Rich metadata for config keys and mutation tools. Injected into LLM tool
// descriptions so the LLM can generate thorough explanations before acting.

// ─── Config Key Metadata (unchanged) ───

export interface ConfigKeyMeta {
  label: string;
  description: string;
  type: "boolean" | "number" | "string";
  effects: string[];
  requirements: string[];
  risks: string[];
  revert: string;
  appliesAt: "next_session" | "immediate";
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
      "複数クライアント（TUI, Web UI）が同時にダエモンを監視できる",
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
  },
};

/** Build a rich description string for a single config key. */
export function buildConfigKeyDescription(key: string): string {
  const m = CONFIG_METADATA[key];
  if (!m) return ;
  const bullet = (arr: string[]) => arr.map(s => ).join("
");
  const timing = m.appliesAt === "next_session" ? "次のセッション（再起動後）から適用" : "即座に適用";
  return [, m.description, "", "### 効果", bullet(m.effects), "",
    "### 必要な環境", bullet(m.requirements), "", "### リスク", bullet(m.risks), "",
    "### 元に戻す方法", m.revert, "", "### 適用タイミング", timing].join("
");
}

/** Build the full tool description with all config keys metadata injected. */
export function buildConfigToolDescription(): string {
  const descs = Object.keys(CONFIG_METADATA).map(k => buildConfigKeyDescription(k)).join("

---

");
  return ["PulSeedの設定を変更する。", "",
    "「重要ルール」このツールを呼ぶ前に、必ず以下の手順を踏むこと：",
    "1. 変更する設定の「効果」「必要な環境」「リスク」「元に戻す方法」「適用タイミング」をすべてユーザーに説明する",
    "2. ユーザーの明示的な同意（「はい」「OK」「大丈夫」等）を得る",
    "3. 同意を得てからこのツールを呼び出す",
    "4. 同意が得られない場合は呼び出さない", "",
    "「利用可能な設定キー」", "", descs].join("
");
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
  if (!m) return ;
  const bullet = (arr: string[]) => arr.map(s => ).join("
");
  return [
    ,
    m.description, "",
    "IMPORTANT: Before calling this tool, you MUST:",
    "1. Explain what will be deleted/affected",
    "2. List the risks",
    "3. State that this cannot be undone",
    "4. Get explicit user confirmation",
    "Only call this tool after the user confirms.", "",
    "### Effects", bullet(m.effects), "",
    "### Risks", bullet(m.risks), "",
    "### Revert", m.revert,
  ].join("
");
}
