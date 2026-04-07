/**
 * Minimal smoke coverage for TaskLifecycle construction.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

describe("TaskLifecycle", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("supports object-shaped constructor deps while preserving behavior", () => {
    const llm = createMockLLMClient([]);
    strategyManager = new StrategyManager(stateManager, llm);

    const lifecycle = new TaskLifecycle({
      stateManager,
      llmClient: llm,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      options: {
        healthCheckEnabled: false,
        execFileSyncFn: () => "some-file.ts",
      },
    });

    expect(lifecycle).toBeInstanceOf(TaskLifecycle);
  });
});
