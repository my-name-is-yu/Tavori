import { useState, useEffect, useRef, useCallback } from "react";
import type { CoreLoop, LoopResult } from "../loop/core-loop.js";
import type { StateManager } from "../state/state-manager.js";
import type { TrustManager } from "../traits/trust-manager.js";
import type { Threshold } from "../types/core.js";

export interface LoopState {
  running: boolean;
  goalId: string | null;
  iteration: number;
  /** "idle" | "running" | "completed" | "stalled" | "error" | "stopped" | "max_iterations" */
  status: string;
  dimensions: DimensionProgress[];
  trustScore: number;
  startedAt: string | null;
  lastResult: LoopResult | null;
  lastError?: string;
}

export interface DimensionProgress {
  name: string;
  displayName: string;
  currentValue: unknown;
  threshold: unknown;
  progress: number; // 0-100
}

// ─── Progress Calculation ───

/**
 * Calculate 0-100 progress for a single dimension based on its threshold type
 * and current_value.
 */
export function calcDimensionProgress(
  currentValue: unknown,
  threshold: Threshold
): number {
  if (currentValue === null || currentValue === undefined) {
    return 0;
  }

  switch (threshold.type) {
    case "present": {
      const truthy =
        currentValue !== false &&
        currentValue !== 0 &&
        currentValue !== "" &&
        currentValue !== null;
      return truthy ? 100 : 0;
    }
    case "match": {
      return currentValue === threshold.value ? 100 : 0;
    }
    case "min": {
      const cur = toNum(currentValue);
      if (threshold.value === 0) return cur >= 0 ? 100 : 0;
      return Math.min(100, Math.max(0, Math.round((cur / threshold.value) * 100)));
    }
    case "max": {
      const cur = toNum(currentValue);
      // For max thresholds: being at or below the target is 100%.
      // Being over the target reduces progress.
      if (cur <= threshold.value) return 100;
      if (threshold.value === 0) return 0;
      // Clamp: once current is 2x target, treat as 0%
      const excess = cur - threshold.value;
      return Math.max(0, Math.round((1 - excess / threshold.value) * 100));
    }
    case "range": {
      const cur = toNum(currentValue);
      return cur >= threshold.low && cur <= threshold.high ? 100 : 0;
    }
  }
}

function toNum(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

// ─── LoopController ───

const POLL_INTERVAL_MS = 2000;

export class LoopController {
  private state: LoopState;
  private onUpdate: ((state: LoopState) => void) | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private coreLoop: CoreLoop,
    private stateManager: StateManager,
    private trustManager: TrustManager
  ) {
    this.state = {
      running: false,
      goalId: null,
      iteration: 0,
      status: "idle",
      dimensions: [],
      trustScore: 0,
      startedAt: null,
      lastResult: null,
    };
  }

  getState(): LoopState {
    return this.state;
  }

  setOnUpdate(cb: ((state: LoopState) => void) | null): void {
    this.onUpdate = cb;
  }

  async start(goalId: string): Promise<void> {
    if (this.state.running) return;

    this.setState({
      running: true,
      goalId,
      iteration: 0,
      status: "running",
      startedAt: new Date().toISOString(),
      lastResult: null,
    });

    // Initial dimension refresh (awaited so dimensions are populated before polling starts)
    await this.refreshState(goalId);

    // Start polling
    this.pollInterval = setInterval(() => {
      if (this.state.goalId) {
        this.refreshState(this.state.goalId);
      }
    }, POLL_INTERVAL_MS);

    // Fire-and-forget: capture result when loop completes
    this.coreLoop.run(goalId).then((result) => {
      this.clearPoll();
      this.setState({
        running: false,
        status: result.finalStatus,
        iteration: result.totalIterations,
        lastResult: result,
      });
      // Final refresh to show end state
      this.refreshState(goalId);
    }).catch((err: unknown) => {
      this.clearPoll();
      const msg = err instanceof Error ? err.message : String(err);
      this.setState({
        running: false,
        status: "error",
        lastResult: null,
        lastError: msg,
      });
    });
  }

  stop(): void {
    this.coreLoop.stop();
    this.clearPoll();
    this.setState({ running: false, status: "stopped", goalId: null });
  }

  async refreshState(goalId: string): Promise<void> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (!goal) return;

    const dimensions: DimensionProgress[] = goal.dimensions.map((dim) => ({
      name: dim.name,
      displayName: dim.label,
      currentValue: dim.current_value,
      threshold: dim.threshold,
      progress: calcDimensionProgress(dim.current_value, dim.threshold),
    }));

    const trustScore = (await this.trustManager.getBalance(goalId)).balance;

    this.setState({ dimensions, trustScore });
  }

  // ─── Private ───

  private setState(partial: Partial<LoopState>): void {
    this.state = { ...this.state, ...partial };
    if (this.onUpdate) {
      this.onUpdate(this.state);
    }
  }

  private clearPoll(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

// ─── useLoop hook ───
//
// React hook that wraps LoopController and exposes loop state + control
// functions directly to React components. Eliminates the need to pass a
// LoopController instance as a prop from entry.ts into App.
//
// Usage:
//   const { loopState, start, stop, setApprovalReadyCallback } = useLoop(coreLoop, stateManager, trustManager);

export interface UseLoopResult {
  loopState: LoopState;
  start: (goalId: string) => void;
  stop: () => void;
  /** Register a callback that will be invoked whenever a LoopController
   *  onUpdate notification would have fired (used by entry.ts approval wiring). */
  getController: () => LoopController;
}

export function useLoop(
  coreLoop: CoreLoop,
  stateManager: StateManager,
  trustManager: TrustManager
): UseLoopResult {
  // Stable controller reference — created once per mount
  const controllerRef = useRef<LoopController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new LoopController(coreLoop, stateManager, trustManager);
  }
  const controller = controllerRef.current;

  const [loopState, setLoopState] = useState<LoopState>(() => controller.getState());

  useEffect(() => {
    controller.setOnUpdate(setLoopState);
    return () => {
      controller.setOnUpdate(null);
      controller.stop();
    };
  }, [controller]);

  const start = useCallback(
    (goalId: string) => {
      void controller.start(goalId);
    },
    [controller]
  );

  const stop = useCallback(() => {
    controller.stop();
  }, [controller]);

  const getController = useCallback(() => controller, [controller]);

  return { loopState, start, stop, getController };
}
