export type GoalLoopStopCode =
  | "completed"
  | "max_iterations"
  | "max_wall_time_cap_seconds";

export interface GoalLoopStopReason {
  code: GoalLoopStopCode;
  message: string;
  detail: {
    iteration: number;
    elapsed_ms: number;
    max_iterations: number;
    max_wall_time_cap_seconds: number;
  };
}

export interface GoalLoopStepResult<T = void> {
  done?: boolean;
  value?: T;
}

export interface GoalLoopConfig {
  maxIterations: number;
  maxWallTimeCapSeconds: number;
  nowMs?: () => number;
}

export interface GoalLoopRunResult<T = void> {
  iterations: number;
  elapsedMs: number;
  value?: T;
  stopReason: GoalLoopStopReason;
}

export class GoalLoop<T = void> {
  private readonly config: GoalLoopConfig;
  private readonly nowMs: () => number;

  constructor(config: GoalLoopConfig) {
    this.config = config;
    this.nowMs = config.nowMs ?? (() => Date.now());
  }

  async run(step: (iteration: number) => Promise<GoalLoopStepResult<T>>): Promise<GoalLoopRunResult<T>> {
    const startedAtMs = this.nowMs();
    let lastValue: T | undefined;
    let iteration = 0;

    while (iteration < this.config.maxIterations) {
      iteration += 1;

      const stepResult = await step(iteration);
      if (typeof stepResult.value !== "undefined") {
        lastValue = stepResult.value;
      }

      const elapsedMs = this.nowMs() - startedAtMs;
      if (stepResult.done === true) {
        return {
          iterations: iteration,
          elapsedMs,
          value: lastValue,
          stopReason: {
            code: "completed",
            message: "Goal loop completed by step result.",
            detail: {
              iteration,
              elapsed_ms: elapsedMs,
              max_iterations: this.config.maxIterations,
              max_wall_time_cap_seconds: this.config.maxWallTimeCapSeconds,
            },
          },
        };
      }

      if (elapsedMs >= this.config.maxWallTimeCapSeconds * 1000) {
        return {
          iterations: iteration,
          elapsedMs,
          value: lastValue,
          stopReason: {
            code: "max_wall_time_cap_seconds",
            message: "Goal loop stopped because max wall-time cap was reached.",
            detail: {
              iteration,
              elapsed_ms: elapsedMs,
              max_iterations: this.config.maxIterations,
              max_wall_time_cap_seconds: this.config.maxWallTimeCapSeconds,
            },
          },
        };
      }
    }

    const elapsedMs = this.nowMs() - startedAtMs;
    return {
      iterations: iteration,
      elapsedMs,
      value: lastValue,
      stopReason: {
        code: "max_iterations",
        message: "Goal loop stopped because max iterations were reached.",
        detail: {
          iteration,
          elapsed_ms: elapsedMs,
          max_iterations: this.config.maxIterations,
          max_wall_time_cap_seconds: this.config.maxWallTimeCapSeconds,
        },
      },
    };
  }
}
