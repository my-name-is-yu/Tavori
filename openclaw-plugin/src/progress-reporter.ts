export interface ProgressEvent {
  iteration: number;
  maxIterations: number;
  phase: string;
  gap?: number;
  confidence?: number;
  taskDescription?: string;
  skipReason?: string;
}

export interface LoopResultSummary {
  goalId: string;
  goalDescription: string;
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped";
  totalIterations: number;
  startValue?: number;
  endValue?: number;
}

export interface StallInfo {
  stallType: string;
  escalationLevel: number;
  newStrategy?: string;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function formatProgress(event: ProgressEvent): string | null {
  if (event.phase !== "Executing task...") return null;
  const task = event.taskDescription ?? "(no description)";
  const gapStr = event.gap !== undefined ? ` | gap: ${pct(event.gap)}` : "";
  return `📊 [${event.iteration}/${event.maxIterations}] ${task}${gapStr}`;
}

export function formatGoalStart(goalDescription: string, dimensions: string[]): string {
  return `🎯 ゴール設定: ${goalDescription}\n📐 計測次元: ${dimensions.join(", ")}`;
}

export function formatStall(info: StallInfo): string {
  const base = `⚠️ 停滞検知（レベル ${info.escalationLevel}/3）: ${info.stallType}`;
  return info.newStrategy ? `${base}\n🔄 戦略変更: ${info.newStrategy}` : base;
}

export function formatCompletion(result: LoopResultSummary): string {
  const { finalStatus, goalDescription, startValue, endValue } = result;
  const range = startValue !== undefined && endValue !== undefined
    ? ` (${pct(startValue)} → ${pct(endValue)})` : "";
  if (finalStatus === "completed") return `✅ ゴール達成！${range}`;
  if (finalStatus === "stalled") return `❌ ゴール停滞: ${goalDescription}${range}`;
  if (finalStatus === "error") return `⚠️ エラーで中断: ${goalDescription}`;
  if (finalStatus === "stopped") return `🛑 停止: ${goalDescription}`;
  return `⏹️ 上限到達（${result.totalIterations}回）: ${goalDescription}`;
}

export function formatSessionResume(goalDescription: string, currentGap: number): string {
  return `🔄 前回のゴールを引き継ぎます: ${goalDescription}（残gap: ${pct(currentGap)}）`;
}
