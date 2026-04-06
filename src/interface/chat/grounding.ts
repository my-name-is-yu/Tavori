// ─── Chat Grounding ───
//
// Builds a system prompt that gives the LLM self-knowledge about PulSeed:
// identity, current state (goals, plugins, provider).

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import { getUserFacingIdentity, getAgentName } from "../../base/config/identity-loader.js";

export interface GroundingOptions {
  stateManager: StateManager;
  /** Base directory for PulSeed config files. Defaults to ~/.pulseed */
  homeDir?: string;
}

// ─── Helpers ───

async function readPlugins(homeDir: string): Promise<string[]> {
  const pluginsDir = path.join(homeDir, "plugins");
  try {
    const entries = await fsp.readdir(pluginsDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readProvider(homeDir: string): Promise<string> {
  const providerPath = path.join(homeDir, "provider.json");
  try {
    const raw = await fsp.readFile(providerPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const llm = typeof parsed.llm === "string" ? parsed.llm : null;
    const adapter = typeof parsed.default_adapter === "string" ? parsed.default_adapter : null;
    if (llm && adapter) return `${llm} / ${adapter}`;
    if (llm) return llm;
    return "not configured";
  } catch {
    return "not configured";
  }
}

async function buildGoalsBlock(stateManager: StateManager): Promise<string> {
  const ids = await stateManager.listGoalIds();
  if (ids.length === 0) return "No goals configured yet.";

  const lines: string[] = [];
  for (const id of ids) {
    const goal = await stateManager.loadGoal(id);
    if (!goal) continue;
    const status = goal.loop_status !== "idle" ? ` [${goal.loop_status}]` : "";
    lines.push(`- ${goal.title} (${id})${status} — status: ${goal.status}`);
  }
  return lines.length > 0 ? lines.join("\n") : "No goals configured yet.";
}

// ─── Main export ───

export async function buildSystemPrompt(options: GroundingOptions): Promise<string> {
  const homeDir = options.homeDir ?? path.join(
    process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp",
    ".pulseed"
  );

  const [goalsBlock, plugins, provider] = await Promise.all([
    buildGoalsBlock(options.stateManager),
    readPlugins(homeDir),
    readProvider(homeDir),
  ]);

  const pluginsLine = plugins.length > 0 ? plugins.join(", ") : "none";
  const identity = getUserFacingIdentity();
  const name = getAgentName();

  return `
${identity}

---

## Current State
### Goals
${goalsBlock}

### Plugins
Installed: ${pluginsLine}

### Provider
${provider}

## Safety Instructions
- 設定変更について：
  ユーザーが設定の変更を求めた場合、update_configツールを使用できます。
  ただし、ツールを呼ぶ前に必ず以下を行ってください：
  1. 変更内容の効果・必要環境・リスク・元に戻す方法を丁寧に説明する
  2. ユーザーの明示的な同意を得る（「はい」「OK」「大丈夫」など）
  3. 同意が得られてからツールを呼び出す
  ユーザーが迷っている場合や、リスクを理解していない様子であれば、追加説明をしてください。
- ゴール削除について：
  ユーザーがゴールの削除を求めた場合、delete_goalツールを使用できます。
  ただし、ツールを呼ぶ前に必ず以下の手順を踏んでください：
  1. 削除対象のゴールと、その子ゴール・セッション・観測データがすべて完全削除されることを説明する
  2. リスクを列挙する（元に戻せない、ゴールIDは再利用不可、実行中セッションは強制終了など）
  3. この操作は取り消せないことを明示する
  4. ユーザーの明示的な確認（「はい」「削除する」など）を得る
  5. 確認を得てからツールを呼び出す
  ユーザーが迷っている場合や削除の影響を理解していない様子であれば、追加説明をしてください。
- Stay focused on goals — you're here to help them grow (${name})
`.trim();
}
