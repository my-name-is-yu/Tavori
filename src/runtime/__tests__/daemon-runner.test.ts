import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Goal } from "../../base/types/goal.js";
import type { Task } from "../../base/types/task.js";
import { StateManager } from "../../base/state/state-manager.js";
import { DaemonRunner } from "../daemon-runner.js";
import { PIDManager } from "../pid-manager.js";
import { Logger } from "../logger.js";
import type { LoopResult } from "../../orchestrator/loop/core-loop.js";
import type { DaemonDeps } from "../daemon-runner.js";
import type { GoalActivationSnapshot } from "../../platform/drive/drive-system.js";
import { makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { JournalBackedQueue } from "../queue/journal-backed-queue.js";
import { GoalLeaseManager } from "../goal-lease-manager.js";
import { createEnvelope } from "../types/envelope.js";
import { runSupervisorMaintenanceCycleForDaemon } from "../daemon/maintenance.js";
import type { DaemonState } from "../../base/types/daemon.js";
import { restoreInterruptedGoals } from "../daemon/persistence.js";

async function pollForFile(
  filePath: string,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
      // Retry until stable.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

async function pollForJsonMatch<T>(
  filePath: string,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(filePath)) {
        const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
        if (predicate(value)) {
          return value;
        }
      }
    } catch {
      // Retry until stable.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for matching JSON in file: ${filePath}`);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

function makeLoopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    goalId: "test-goal",
    totalIterations: 1,
    finalStatus: "completed",
    iterations: [],
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps(tmpDir: string, overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  const mockCoreLoop = {
    run: vi.fn().mockResolvedValue(makeLoopResult()),
    stop: vi.fn(),
  };

  const mockDriveSystem = {
    getGoalActivationSnapshot: vi.fn(async (goalId: string): Promise<GoalActivationSnapshot> => ({
      goalId,
      shouldActivate: false,
      schedule: null,
    })),
    shouldActivate: vi.fn().mockReturnValue(false),
    getSchedule: vi.fn().mockResolvedValue(null),
    prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    startWatcher: vi.fn(),
    stopWatcher: vi.fn(),
    writeEvent: vi.fn().mockResolvedValue(undefined),
  };

  const mockStateManager = {
    getBaseDir: vi.fn().mockReturnValue(tmpDir),
    loadGoal: vi.fn().mockResolvedValue(null),
    listGoalIds: vi.fn().mockResolvedValue([]),
  };

  const pidManager = new PIDManager(tmpDir);
  const logger = new Logger({
    dir: path.join(tmpDir, "logs"),
    consoleOutput: false,
    level: "error",
  });

  return {
    coreLoop: mockCoreLoop as unknown as DaemonDeps["coreLoop"],
    driveSystem: mockDriveSystem as unknown as DaemonDeps["driveSystem"],
    stateManager: mockStateManager as unknown as DaemonDeps["stateManager"],
    pidManager,
    logger,
    ...overrides,
  };
}

function makeEventServerMock() {
  return {
    setEnvelopeHook: vi.fn(),
    setCommandEnvelopeHook: vi.fn(),
    setActiveWorkersProvider: vi.fn(),
    setApprovalBroker: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getPort: vi.fn().mockReturnValue(41700),
    startFileWatcher: vi.fn(),
    stopFileWatcher: vi.fn(),
    broadcast: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
  };
}

function createPersistedStateFile(tmpDir: string, state: DaemonState): {
  filePath: string;
  saveDaemonState: () => Promise<void>;
} {
  const filePath = path.join(tmpDir, "daemon-state.json");
  fs.writeFileSync(filePath, JSON.stringify(state));

  return {
    filePath,
    saveDaemonState: async () => {
      fs.writeFileSync(filePath, JSON.stringify(state));
    },
  };
}

describe("DaemonRunner durable runtime", () => {
  let tmpDir: string;
  let currentDaemon: DaemonRunner | null = null;
  let currentStartPromise: Promise<void> | null = null;

  beforeEach(() => {
    tmpDir = makeTempDir();
    currentDaemon = null;
    currentStartPromise = null;
  });

  afterEach(async () => {
    if (currentDaemon) {
      currentDaemon.stop();
      currentDaemon = null;
    }
    if (currentStartPromise) {
      await currentStartPromise.catch(() => {});
      currentStartPromise = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  });

  it("constructs with minimal deps and partial config overrides", () => {
    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 1_000,
        crash_recovery: { enabled: true, max_retries: 1, retry_delay_ms: 500 },
      },
    });
    expect(() => new DaemonRunner(deps)).not.toThrow();
  });

  it("saves daemon-state.json with running status and active goals on start", async () => {
    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-a", "goal-b"]);
    currentStartPromise = startPromise;

    const state = await pollForFile(path.join(tmpDir, "daemon-state.json")) as {
      status: string;
      active_goals: string[];
    };
    expect(state.status).toBe("running");
    expect(state.active_goals).toEqual(["goal-a", "goal-b"]);

    daemon.stop();
    await startPromise;
  });

  it("does not block startup readiness on the initial runtime store maintenance pass", async () => {
    let finishMaintenance!: () => void;
    let maintenanceFinished = false;
    const maintenanceGate = new Promise<void>((resolve) => {
      finishMaintenance = resolve;
    });
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    const runRuntimeStoreMaintenance = vi.fn(async () => {
      await maintenanceGate;
      maintenanceFinished = true;
    });
    (daemon as unknown as {
      runRuntimeStoreMaintenance(force?: boolean): Promise<void>;
    }).runRuntimeStoreMaintenance = runRuntimeStoreMaintenance;
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-a"]);
    currentStartPromise = startPromise;

    await waitFor(() => runRuntimeStoreMaintenance.mock.calls.length > 0);
    const state = await pollForJsonMatch<{
      status: string;
      active_goals: string[];
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.status === "running" && value.active_goals.includes("goal-a")
    );

    expect(state.active_goals).toEqual(["goal-a"]);
    expect(eventServer.start).toHaveBeenCalledOnce();
    expect(runRuntimeStoreMaintenance).toHaveBeenCalledWith(true);
    expect(maintenanceFinished).toBe(false);

    let startSettled = false;
    startPromise.then(
      () => {
        startSettled = true;
      },
      () => {
        startSettled = true;
      }
    );

    daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(startSettled).toBe(false);

    finishMaintenance();
    await startPromise;
    expect(maintenanceFinished).toBe(true);
  });

  it("cleans up and propagates initial runtime store maintenance failures on shutdown", async () => {
    const maintenanceError = new Error("startup maintenance failed");
    let rejectMaintenance!: (reason: Error) => void;
    const maintenanceGate = new Promise<void>((_, reject) => {
      rejectMaintenance = reject;
    });
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    const runRuntimeStoreMaintenance = vi.fn(async () => {
      await maintenanceGate;
    });
    (daemon as unknown as {
      runRuntimeStoreMaintenance(force?: boolean): Promise<void>;
    }).runRuntimeStoreMaintenance = runRuntimeStoreMaintenance;
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-a"]);
    startPromise.catch(() => {});
    currentStartPromise = startPromise;

    await waitFor(() => runRuntimeStoreMaintenance.mock.calls.length > 0);
    await pollForJsonMatch<{ status: string; active_goals: string[] }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.status === "running" && value.active_goals.includes("goal-a")
    );

    rejectMaintenance(maintenanceError);
    daemon.stop();
    await expect(startPromise).rejects.toThrow("startup maintenance failed");

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8"));
    expect(state.status).toBe("stopped");

    const marker = JSON.parse(fs.readFileSync(path.join(tmpDir, "shutdown-state.json"), "utf-8"));
    expect(marker.state).toBe("clean_shutdown");
    expect(marker.goal_ids).toEqual(["goal-a"]);
  });

  it("starts in idle status when launched without initial goals", async () => {
    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForFile(path.join(tmpDir, "daemon-state.json")) as {
      status: string;
      active_goals: string[];
    };
    expect(state.status).toBe("idle");
    expect(state.active_goals).toEqual([]);

    daemon.stop();
    await startPromise;
  });

  it("refreshes resident deps when provider fingerprint changes while idle", async () => {
    const refreshedCoreLoop = {
      run: vi.fn().mockResolvedValue(makeLoopResult({ goalId: "goal-after-refresh" })),
      stop: vi.fn(),
    };
    const getProviderRuntimeFingerprint = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("fingerprint-a")
      .mockResolvedValueOnce("fingerprint-b")
      .mockResolvedValue("fingerprint-b");
    const refreshResidentDeps = vi.fn().mockResolvedValue({
      coreLoop: refreshedCoreLoop,
      llmClient: {
        sendMessage: vi.fn(),
        parseJSON: vi.fn(),
      },
    });

    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 20 },
      getProviderRuntimeFingerprint,
      refreshResidentDeps,
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    await waitFor(() => refreshResidentDeps.mock.calls.length === 1, 2_000, 20);
    expect(refreshResidentDeps).toHaveBeenCalledOnce();
    await (daemon as unknown as { handleGoalStartCommand(goalId: string): Promise<void> })
      .handleGoalStartCommand("goal-after-refresh");
    await waitFor(
      () => refreshedCoreLoop.run.mock.calls.some((call: unknown[]) => call[0] === "goal-after-refresh"),
      2_000,
      20
    );

    daemon.stop();
    await startPromise;
  });

  it("does not refresh resident deps while a goal is actively running", async () => {
    let releaseRun!: () => void;
    const runPromise = new Promise<LoopResult>((resolve) => {
      releaseRun = () => resolve(makeLoopResult({ goalId: "goal-active" }));
    });

    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 20 },
      coreLoop: {
        run: vi.fn().mockReturnValue(runPromise),
        stop: vi.fn(),
      } as unknown as DaemonDeps["coreLoop"],
      driveSystem: {
        getGoalActivationSnapshot: vi.fn(async (goalId: string): Promise<GoalActivationSnapshot> => ({
          goalId,
          shouldActivate: true,
          schedule: null,
        })),
        shouldActivate: vi.fn().mockReturnValue(true),
        getSchedule: vi.fn().mockResolvedValue(null),
        prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
        startWatcher: vi.fn(),
        stopWatcher: vi.fn(),
        writeEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as DaemonDeps["driveSystem"],
      getProviderRuntimeFingerprint: vi
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("fingerprint-a")
        .mockResolvedValueOnce("fingerprint-b")
        .mockResolvedValue("fingerprint-b"),
      refreshResidentDeps: vi.fn().mockResolvedValue({
        coreLoop: {
          run: vi.fn().mockResolvedValue(makeLoopResult({ goalId: "unused" })),
          stop: vi.fn(),
        },
      }),
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-active"]);
    currentStartPromise = startPromise;

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() => runMock.mock.calls.length > 0, 2_000, 20);
    vi.mocked(deps.refreshResidentDeps!).mockClear();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(deps.refreshResidentDeps).not.toHaveBeenCalled();

    daemon.stop();
    releaseRun();
    await startPromise;
  });

  it("negotiates a resident goal from idle proactive discovery and activates it", async () => {
    const residentGoal = {
      id: "resident-goal",
      title: "Add resident daemon coverage",
    } as Goal;
    const goalNegotiator = {
      suggestGoals: vi.fn().mockResolvedValue([
        {
          title: "Add resident daemon coverage",
          description: "Add regression coverage for idle daemon resident discovery.",
          rationale: "Resident mode should create work from idle.",
          dimensions_hint: ["test_coverage"],
        },
      ]),
      negotiate: vi.fn().mockResolvedValue({
        goal: residentGoal,
        response: {},
        log: {},
      }),
    };
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          action: "suggest_goal",
          details: {
            title: "Find one resident improvement",
            description: "Look for a concrete always-on improvement in the current workspace.",
          },
        }),
      }),
      parseJSON: vi.fn((content: string) => JSON.parse(content)),
    };

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      goalNegotiator: goalNegotiator as unknown as DaemonDeps["goalNegotiator"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      status: string;
      active_goals: string[];
      resident_activity: { kind: string; goal_id?: string; summary: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) =>
        value.active_goals.includes("resident-goal")
        && value.resident_activity?.kind === "negotiation"
    );

    expect(state.status).toBe("running");
    expect(state.active_goals).toContain("resident-goal");
    expect(state.resident_activity).toEqual(expect.objectContaining({
      kind: "negotiation",
      goal_id: "resident-goal",
    }));

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() => runMock.mock.calls.some((call: unknown[]) => call[0] === "resident-goal"));

    expect(goalNegotiator.suggestGoals).toHaveBeenCalledOnce();
    expect(goalNegotiator.negotiate).toHaveBeenCalledWith(
      "Add regression coverage for idle daemon resident discovery.",
      expect.objectContaining({
        timeoutMs: 30_000,
      })
    );

    daemon.stop();
    await startPromise;
  });

  it("runs resident curiosity investigation from idle proactive ticks", async () => {
    const curiosityEngine = {
      evaluateTriggers: vi.fn().mockResolvedValue([
        {
          type: "periodic_exploration",
          detected_at: new Date().toISOString(),
          source_goal_id: null,
          details: "Resident investigation found room for periodic exploration.",
          severity: 0.3,
        },
      ]),
      generateProposals: vi.fn().mockResolvedValue([
        {
          id: "curiosity-1",
          trigger: {
            type: "periodic_exploration",
            detected_at: new Date().toISOString(),
            source_goal_id: null,
            details: "Resident investigation found room for periodic exploration.",
            severity: 0.3,
          },
          proposed_goal: {
            description: "Explore weak spots in idle daemon resident behavior.",
            rationale: "Periodic exploration should turn idle time into useful investigation.",
            suggested_dimensions: [
              {
                name: "resident_autonomy",
                threshold_type: "min",
                target: 0.7,
              },
            ],
            scope_domain: "engineering",
            detection_method: "periodic_review",
          },
          status: "pending",
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          reviewed_at: null,
          rejection_cooldown_until: null,
          loop_count: 0,
          goal_id: null,
        },
      ]),
    };
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          action: "investigate",
          details: {
            what: "idle daemon autonomy",
            why: "Look for the next resident behavior to wire.",
          },
        }),
      }),
      parseJSON: vi.fn((content: string) => JSON.parse(content)),
    };

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      curiosityEngine: curiosityEngine as unknown as DaemonDeps["curiosityEngine"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      status: string;
      resident_activity: { kind: string; summary: string; suggestion_title?: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.resident_activity?.kind === "curiosity"
    );

    expect(state.status).toBe("idle");
    expect(state.resident_activity).toEqual(expect.objectContaining({
      kind: "curiosity",
      suggestion_title: "Explore weak spots in idle daemon resident behavior.",
    }));
    expect(curiosityEngine.evaluateTriggers).toHaveBeenCalledOnce();
    expect(curiosityEngine.generateProposals).toHaveBeenCalledOnce();
    expect(llmClient.sendMessage).not.toHaveBeenCalled();

    daemon.stop();
    await startPromise;
  });

  it("runs scheduled goal review before proactive LLM decisions", async () => {
    const curiosityEngine = {
      evaluateTriggers: vi.fn().mockResolvedValue([]),
      generateProposals: vi.fn(),
    };
    const llmClient = {
      sendMessage: vi.fn(),
      parseJSON: vi.fn(),
    };

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 60_000,
        goal_review_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      curiosityEngine: curiosityEngine as unknown as DaemonDeps["curiosityEngine"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      resident_activity: { kind: string; trigger: string; summary: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.resident_activity?.trigger === "schedule"
    );

    expect(state.resident_activity).toEqual(expect.objectContaining({
      kind: "curiosity",
      trigger: "schedule",
    }));
    expect(state.resident_activity?.summary).toContain("goal review");
    expect(curiosityEngine.evaluateTriggers).toHaveBeenCalledOnce();
    expect(llmClient.sendMessage).not.toHaveBeenCalled();

    daemon.stop();
    await startPromise;
  });

  it("runs resident dream maintenance from idle proactive ticks", async () => {
    const scheduleEngine = {
      tick: vi.fn().mockResolvedValue([]),
      getEntries: vi.fn().mockReturnValue([]),
      addEntry: vi.fn().mockResolvedValue({
        id: "schedule-entry-1",
        name: "Dream resident schedule",
      }),
    };
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          action: "sleep",
        }),
      }),
      parseJSON: vi.fn((content: string) => JSON.parse(content)),
    };

    fs.mkdirSync(path.join(tmpDir, "dream"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "dream", "schedule-suggestions.json"),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        suggestions: [
          {
            id: "dream-1",
            type: "cron",
            name: "Dream resident schedule",
            confidence: 0.9,
            reason: "Follow up on resident daemon maintenance during idle time.",
            proposal: "0 * * * *",
            status: "pending",
          },
        ],
      })
    );

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      scheduleEngine: scheduleEngine as unknown as DaemonDeps["scheduleEngine"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      status: string;
      resident_activity: { kind: string; summary: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.resident_activity?.kind === "dream"
    );

    const suggestionFile = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "dream", "schedule-suggestions.json"), "utf-8")
    ) as {
      suggestions: Array<{ status: string; applied_entry_id?: string }>;
    };

    expect(state.status).toBe("idle");
    expect(state.resident_activity?.summary).toContain("applied pending suggestion");
    expect(scheduleEngine.addEntry).toHaveBeenCalledOnce();
    expect(suggestionFile.suggestions[0]).toEqual(expect.objectContaining({
      status: "applied",
      applied_entry_id: "schedule-entry-1",
    }));

    daemon.stop();
    await startPromise;
  });

  it("runs resident dream light analysis during idle sleep cycles", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          action: "sleep",
        }),
      }),
      parseJSON: vi.fn((content: string) => JSON.parse(content)),
    };

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      resident_activity: { kind: string; summary: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.resident_activity?.summary.includes("light analysis") ?? false
    );

    expect(state.resident_activity).toEqual(expect.objectContaining({
      kind: "dream",
    }));

    daemon.stop();
    await startPromise;
  });

  it("caps idle daemon re-checks at 5 seconds", async () => {
    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 10_000,
      },
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    (daemon as any).running = true;
    (daemon as any).shuttingDown = false;
    (daemon as any).currentGoalIds = [];

    vi.spyOn(daemon as any, "runRuntimeStoreMaintenance").mockResolvedValue(undefined);
    vi.spyOn(daemon as any, "proactiveTick").mockResolvedValue(undefined);
    vi.spyOn(daemon as any, "saveDaemonState").mockResolvedValue(undefined);
    vi.spyOn(daemon as any, "processCronTasks").mockResolvedValue(undefined);
    vi.spyOn(daemon as any, "processScheduleEntries").mockResolvedValue(undefined);
    const adaptiveIntervalSpy = vi
      .spyOn(daemon as any, "calculateAdaptiveInterval")
      .mockReturnValue(30_000);

    let scheduledSleepMs: number | null = null;
    const sleepSpy = vi.spyOn(daemon as any, "sleep").mockImplementation(async (...args: unknown[]) => {
      scheduledSleepMs = args[0] as number;
      daemon.stop();
    });

    const runLoopPromise = (daemon as any).runLoop();
    currentStartPromise = runLoopPromise;

    await runLoopPromise;

    expect(sleepSpy).toHaveBeenCalledOnce();
    expect(adaptiveIntervalSpy).toHaveBeenCalledOnce();
    expect(scheduledSleepMs).toBe(5_000);
  }, 10_000);

  it("queues an observation wake-up for resident preemptive checks", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          action: "preemptive_check",
          details: {
            goal_id: "resident-goal",
          },
        }),
      }),
      parseJSON: vi.fn((content: string) => JSON.parse(content)),
    };
    const residentGoal = {
      id: "resident-goal",
      title: "Resident observation target",
      description: "Target goal for preemptive observation.",
      status: "active",
      dimensions: [],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: [],
      children_ids: [],
      target_date: null,
      origin: "manual",
      pace_snapshot: null,
      deadline: null,
      confidence_flag: null,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1,
      decomposition_depth: 0,
      specificity_score: null,
      loop_status: "idle",
      parent_id: null,
      node_type: "goal",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as Goal;

    const stateManager = {
      getBaseDir: vi.fn().mockReturnValue(tmpDir),
      loadGoal: vi.fn(async (goalId: string) => (goalId === "resident-goal" ? residentGoal : null)),
      listGoalIds: vi.fn().mockResolvedValue(["resident-goal"]),
    };

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      stateManager: stateManager as unknown as DaemonDeps["stateManager"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      status: string;
      active_goals: string[];
      resident_activity: { kind: string; summary: string; goal_id?: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.resident_activity?.kind === "observation",
    );

    expect(state.status).toBe("running");
    expect(state.active_goals).toContain("resident-goal");
    expect(state.resident_activity).toEqual(expect.objectContaining({
      kind: "observation",
      goal_id: "resident-goal",
    }));
    expect(
      (deps.driveSystem as unknown as { writeEvent: ReturnType<typeof vi.fn> }).writeEvent
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "resident-proactive",
        data: expect.objectContaining({
          event_type: "preemptive_check",
          goal_id: "resident-goal",
        }),
      }),
    );

    daemon.stop();
    await startPromise;
  });

  it("degrades to resident error when dream suggestion storage is malformed", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          action: "sleep",
        }),
      }),
      parseJSON: vi.fn((content: string) => JSON.parse(content)),
    };

    fs.mkdirSync(path.join(tmpDir, "dream"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "dream", "schedule-suggestions.json"),
      JSON.stringify({ generated_at: 42, suggestions: {} }),
      "utf-8",
    );

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        proactive_mode: true,
        proactive_interval_ms: 0,
      },
      llmClient: llmClient as unknown as DaemonDeps["llmClient"],
      memoryLifecycle: {} as DaemonDeps["memoryLifecycle"],
      knowledgeManager: {} as DaemonDeps["knowledgeManager"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{
      status: string;
      resident_activity: { kind: string; summary: string } | null;
    }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.resident_activity?.summary.includes("Resident dream maintenance failed") ?? false,
    );

    expect(state.status).toBe("idle");
    expect(state.resident_activity?.summary).toContain("Resident dream maintenance failed");

    daemon.stop();
    await startPromise;
  });

  it("writes stopped state, interrupted goals, and a clean shutdown marker on stop", async () => {
    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await pollForFile(path.join(tmpDir, "daemon-state.json"));

    daemon.stop();
    await startPromise;

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8"));
    expect(state.status).toBe("stopped");
    expect(state.interrupted_goals).toEqual(["goal-1"]);

    const marker = JSON.parse(fs.readFileSync(path.join(tmpDir, "shutdown-state.json"), "utf-8"));
    expect(marker.state).toBe("clean_shutdown");
    expect(marker.goal_ids).toEqual(["goal-1"]);
  });

  it("restores interrupted goals from the previous daemon state", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: ["goal-old"],
        interrupted_goals: ["goal-old", "goal-extra"],
        status: "stopped",
        crash_count: 0,
        last_error: null,
      })
    );

    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-new", "goal-old"]);
    currentStartPromise = startPromise;

    const state = await pollForJsonMatch<{ active_goals: string[] }>(
      path.join(tmpDir, "daemon-state.json"),
      (value) => value.active_goals.includes("goal-extra")
    );
    expect(state.active_goals).toEqual(["goal-new", "goal-old", "goal-extra"]);

    daemon.stop();
    await startPromise;
  });

  it("restores active goals from an unclean previous state when interrupted goals are absent", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        pid: 12345,
        started_at: new Date().toISOString(),
        last_loop_at: null,
        loop_count: 3,
        active_goals: ["goal-crashed", "goal-extra"],
        status: "running",
        crash_count: 1,
        last_error: "simulated crash",
      })
    );

    const deps = makeDeps(tmpDir, { config: { check_interval_ms: 50 } });
    const restored = await restoreInterruptedGoals(tmpDir, [], deps.logger);
    expect(restored).toEqual(["goal-crashed", "goal-extra"]);
  });

  it("starts and stops the event server when provided", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await pollForFile(path.join(tmpDir, "daemon-state.json"));
    daemon.stop();
    await startPromise;

    expect(eventServer.start).toHaveBeenCalledOnce();
    expect(eventServer.stop).toHaveBeenCalledOnce();
  });

  it("initializes durable runtime state and does not create a PID file", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50, runtime_journal_v2: true },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await waitFor(() => fs.existsSync(path.join(tmpDir, "runtime", "queue.json")));

    daemon.stop();
    await startPromise;

    const runtimeDir = path.join(tmpDir, "runtime");
    expect(fs.existsSync(path.join(runtimeDir, "approvals", "pending"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "outbox"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "health", "daemon.json"))).toBe(true);
    expect(fs.existsSync(path.join(runtimeDir, "queue.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pulseed.pid"))).toBe(false);
  });

  it("persists supervisor state inside the runtime root", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50, runtime_journal_v2: true },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;
    await waitFor(() => fs.existsSync(path.join(tmpDir, "runtime", "supervisor-state.json")));

    daemon.stop();
    await startPromise;

    expect(fs.existsSync(path.join(tmpDir, "runtime", "supervisor-state.json"))).toBe(true);
  });

  it("reconciles running tasks on startup, preserves retry context, and restores the goal", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const runningTask = makeTask({
      id: "task-recover",
      goal_id: "goal-recover",
      status: "running",
      started_at: new Date(Date.now() - 5_000).toISOString(),
    });
    await stateManager.writeRaw(`tasks/${runningTask.goal_id}/${runningTask.id}.json`, runningTask);

    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      stateManager: stateManager as unknown as DaemonDeps["stateManager"],
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() => runMock.mock.calls.some((call: unknown[]) => call[0] === "goal-recover"));

    daemon.stop();
    await startPromise;

    const reconciledTask = await stateManager.readRaw(
      `tasks/${runningTask.goal_id}/${runningTask.id}.json`
    ) as Record<string, unknown>;
    expect(reconciledTask.status).toBe("error");
    expect(typeof reconciledTask.completed_at).toBe("string");
    expect(String(reconciledTask.execution_output)).toContain("[RECOVERED]");

    const history = await stateManager.readRaw(`tasks/${runningTask.goal_id}/task-history.json`) as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      task_id: "task-recover",
      status: "error",
    });

    const ledger = await stateManager.readRaw(
      `tasks/${runningTask.goal_id}/ledger/${runningTask.id}.json`
    ) as { events: Array<{ type: string; reason?: string; action?: string }> };
    expect(ledger.events.map((event) => event.type)).toEqual(["failed", "retried"]);
    expect(ledger.events[1]).toMatchObject({
      action: "keep",
      reason: "daemon restarted; task preserved for retry",
    });
  });

  it("marks stale running pipelines as interrupted on startup", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    await stateManager.writeRaw("pipelines/task-pipeline.json", {
      pipeline_id: "pipe-1",
      task_id: "task-pipeline",
      current_stage_index: 1,
      completed_stages: [],
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      updated_at: new Date(Date.now() - 5_000).toISOString(),
    });

    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      stateManager: stateManager as unknown as DaemonDeps["stateManager"],
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;
    await pollForJsonMatch<{ status: string }>(
      path.join(tmpDir, "pipelines", "task-pipeline.json"),
      (value) => value.status === "interrupted"
    );

    daemon.stop();
    await startPromise;
  });

  it("holds the leader lock, emits runtime heartbeats, and releases leadership on stop", async () => {
    const eventServer = makeEventServerMock();
    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50, runtime_journal_v2: true },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start(["goal-1"]);
    currentStartPromise = startPromise;

    const runtimeDir = path.join(tmpDir, "runtime");
    const leaderRecord = await pollForJsonMatch<{ pid: number; lease_until: number }>(
      path.join(runtimeDir, "leader", "leader.json"),
      (value) => value.pid === process.pid && value.lease_until > Date.now()
    );
    expect(leaderRecord.pid).toBe(process.pid);

    const healthRecord = await pollForJsonMatch<{ leader: boolean; details?: { pid?: number } }>(
      path.join(runtimeDir, "health", "daemon.json"),
      (value) => value.leader === true
    );
    expect(healthRecord.details?.pid).toBe(process.pid);

    daemon.stop();
    await startPromise;
    currentDaemon = null;
    currentStartPromise = null;

    expect(fs.existsSync(path.join(runtimeDir, "leader", "leader.json"))).toBe(false);
    const finalHealth = JSON.parse(fs.readFileSync(path.join(runtimeDir, "health", "daemon.json"), "utf-8"));
    expect(finalHealth.leader).toBe(false);
  });

  it("anchors a relative runtime_root to the daemon base dir", async () => {
    const eventServer = makeEventServerMock();
    const otherCwd = makeTempDir();
    const originalCwd = process.cwd();
    process.chdir(otherCwd);

    try {
      const deps = makeDeps(tmpDir, {
        config: {
          check_interval_ms: 50,
          runtime_journal_v2: true,
          runtime_root: "runtime-v2",
        },
        eventServer: eventServer as unknown as DaemonDeps["eventServer"],
      });
      const daemon = new DaemonRunner(deps);
      currentDaemon = daemon;

      const startPromise = daemon.start(["goal-1"]);
      currentStartPromise = startPromise;
      await waitFor(() => fs.existsSync(path.join(tmpDir, "runtime-v2", "health", "daemon.json")));
      await waitFor(() => {
        const statePath = path.join(tmpDir, "daemon-state.json");
        if (!fs.existsSync(statePath)) {
          return false;
        }
        const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as { status?: string };
        return state.status === "running";
      });

      daemon.stop();
      await startPromise;

      expect(fs.existsSync(path.join(tmpDir, "runtime-v2", "health", "daemon.json"))).toBe(true);
      expect(fs.existsSync(path.join(otherCwd, "runtime-v2", "health", "daemon.json"))).toBe(false);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(otherCwd, { recursive: true, force: true });
    }
  });

  it("reclaims expired queue claims on startup and resumes execution", async () => {
    const eventServer = makeEventServerMock();
    const runtimeDir = path.join(tmpDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });

    const queue = new JournalBackedQueue({
      journalPath: path.join(runtimeDir, "queue.json"),
    });
    const leaseManager = new GoalLeaseManager(runtimeDir, 1);
    const envelope = createEnvelope({
      type: "event",
      name: "goal_activated",
      source: "restart-test",
      goal_id: "g-recover",
      payload: {},
      priority: "normal",
    });
    queue.accept(envelope);
    const claim = queue.claim("worker-old", 1);
    expect(claim).not.toBeNull();
    await leaseManager.acquire("g-recover", {
      workerId: "worker-old",
      ownerToken: claim!.claimToken,
      attemptId: claim!.claimToken,
      leaseMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() => runMock.mock.calls.some((call: unknown[]) => call[0] === "g-recover"));

    daemon.stop();
    await startPromise;

    const persistedQueue = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "queue.json"), "utf-8")
    ) as {
      records: Record<string, { status: string; envelope?: { goal_id?: string; name?: string } }>;
    };
    expect(Object.values(persistedQueue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            name: "goal_activated",
            goal_id: "g-recover",
          }),
        }),
      ])
    );
  });

  it("reclaims expired startup claims even after three prior attempts", async () => {
    const eventServer = makeEventServerMock();
    const runtimeDir = path.join(tmpDir, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });

    const queue = new JournalBackedQueue({
      journalPath: path.join(runtimeDir, "queue.json"),
    });
    const envelope = createEnvelope({
      type: "event",
      name: "goal_activated",
      source: "restart-test",
      goal_id: "g-many-attempts",
      payload: {},
      priority: "normal",
    });
    queue.accept(envelope);
    const claim1 = queue.claim("worker-1", 100);
    expect(claim1).not.toBeNull();
    expect(queue.nack(claim1!.claimToken, "boom", true)).toBe(true);
    const claim2 = queue.claim("worker-2", 100);
    expect(claim2).not.toBeNull();
    expect(queue.nack(claim2!.claimToken, "boom", true)).toBe(true);
    const claim3 = queue.claim("worker-3", 1);
    expect(claim3?.attempt).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const deps = makeDeps(tmpDir, {
      config: { check_interval_ms: 50 },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);
    currentDaemon = daemon;

    const startPromise = daemon.start([]);
    currentStartPromise = startPromise;

    const runMock = (deps.coreLoop as unknown as { run: ReturnType<typeof vi.fn> }).run;
    await waitFor(() => runMock.mock.calls.some((call: unknown[]) => call[0] === "g-many-attempts"));

    daemon.stop();
    await startPromise;

    const persistedQueue = JSON.parse(
      fs.readFileSync(path.join(runtimeDir, "queue.json"), "utf-8")
    ) as {
      records: Record<string, { status: string; deadletterReason?: string; envelope?: { goal_id?: string } }>;
    };
    expect(Object.values(persistedQueue.records)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "completed",
          envelope: expect.objectContaining({
            goal_id: "g-many-attempts",
          }),
        }),
      ])
    );
  });

  it("does not leave a stale PID file when runtime initialization fails", async () => {
    const eventServer = makeEventServerMock();
    const blockedPath = path.join(tmpDir, "not-a-directory");
    fs.writeFileSync(blockedPath, "block");

    const deps = makeDeps(tmpDir, {
      config: {
        check_interval_ms: 50,
        runtime_journal_v2: true,
        runtime_root: path.join("not-a-directory", "child"),
      },
      eventServer: eventServer as unknown as DaemonDeps["eventServer"],
    });
    const daemon = new DaemonRunner(deps);

    await expect(daemon.start(["goal-1"])).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, "pulseed.pid"))).toBe(false);
  });

  it("reuses a cycle-local schedule snapshot for activation ordering and adaptive sleep", async () => {
    const getGoalActivationSnapshot = vi.fn(async (goalId: string): Promise<GoalActivationSnapshot> => {
      if (goalId === "goal-soon") {
        return {
          goalId,
          shouldActivate: true,
          schedule: {
            goal_id: goalId,
            next_check_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
            check_interval_hours: 1,
            last_triggered_at: null,
            consecutive_actions: 0,
            cooldown_until: null,
            current_interval_hours: 1,
            last_gap_score: 2,
          } as GoalActivationSnapshot["schedule"],
        };
      }

      return {
        goalId,
        shouldActivate: true,
        schedule: {
          goal_id: goalId,
          next_check_at: new Date("2026-01-02T00:00:00.000Z").toISOString(),
          check_interval_hours: 1,
          last_triggered_at: null,
          consecutive_actions: 0,
          cooldown_until: null,
          current_interval_hours: 1,
          last_gap_score: 7,
        } as GoalActivationSnapshot["schedule"],
      };
    });
    const prioritizeGoals = vi.fn((goalIds: string[], scores: Map<string, number>) =>
      [...goalIds].sort((left, right) => (scores.get(right) ?? 0) - (scores.get(left) ?? 0))
    );
    const deps = makeDeps(tmpDir, {
      driveSystem: {
        getGoalActivationSnapshot,
        shouldActivate: vi.fn().mockResolvedValue(true),
        getSchedule: vi.fn(() => {
          throw new Error("getSchedule should not be called when cycle snapshots are provided");
        }),
        prioritizeGoals,
        startWatcher: vi.fn(),
        stopWatcher: vi.fn(),
        writeEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as DaemonDeps["driveSystem"],
      config: {
        check_interval_ms: 50,
      },
    });
    const daemon = new DaemonRunner(deps);

    const snapshot = await (daemon as any).collectGoalCycleSnapshot(["goal-later", "goal-soon"]);
    const activeGoals = await (daemon as any).determineActiveGoals(["goal-later", "goal-soon"], snapshot);
    const maxGapScore = await (daemon as any).getMaxGapScore(["goal-later", "goal-soon"], snapshot);

    expect(activeGoals).toEqual(["goal-soon", "goal-later"]);
    expect(maxGapScore).toBe(7);
    expect(getGoalActivationSnapshot).toHaveBeenCalledTimes(2);
    expect(getGoalActivationSnapshot).toHaveBeenNthCalledWith(1, "goal-later");
    expect(getGoalActivationSnapshot).toHaveBeenNthCalledWith(2, "goal-soon");
    expect(prioritizeGoals).toHaveBeenCalledTimes(1);
  });

  it("generates cron entries for daemon scheduling", () => {
    expect(DaemonRunner.generateCronEntry("goal-1", 15)).toContain("goal-1");
    expect(DaemonRunner.generateCronEntry("goal-1", 15)).toContain("*/15");
  });

  it("does not rewrite daemon-state.json during idle supervisor maintenance", async () => {
    const state: DaemonState = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: ["goal-1"],
      interrupted_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    };
    const { filePath, saveDaemonState } = createPersistedStateFile(tmpDir, state);
    const saveSpy = vi.fn(saveDaemonState);
    const driveSystem = {
      getGoalActivationSnapshot: vi.fn(async (goalId: string) => ({
        goalId,
        shouldActivate: false,
        schedule: null,
      })),
      shouldActivate: vi.fn().mockResolvedValue(false),
      getSchedule: vi.fn().mockResolvedValue(null),
      prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    };

    const before = fs.statSync(filePath).mtimeMs;
    await runSupervisorMaintenanceCycleForDaemon({
      currentGoalIds: ["goal-1"],
      driveSystem: driveSystem as never,
      supervisor: null,
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      saveDaemonState: saveSpy,
      state,
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(fs.statSync(filePath).mtimeMs).toBe(before);
  });

  it("persists daemon-state.json when supervisor maintenance changes active goals", async () => {
    const state: DaemonState = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      interrupted_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    };
    const { filePath, saveDaemonState } = createPersistedStateFile(tmpDir, state);
    const saveSpy = vi.fn(saveDaemonState);
    const driveSystem = {
      getGoalActivationSnapshot: vi.fn(async (goalId: string) => ({
        goalId,
        shouldActivate: true,
        schedule: null,
      })),
      shouldActivate: vi.fn().mockResolvedValue(true),
      getSchedule: vi.fn().mockResolvedValue(null),
      prioritizeGoals: vi.fn().mockImplementation((ids: string[]) => ids),
    };
    const supervisor = {
      activateGoal: vi.fn((goalId: string) => {
        state.active_goals = [goalId];
      }),
    };

    await runSupervisorMaintenanceCycleForDaemon({
      currentGoalIds: ["goal-2"],
      driveSystem: driveSystem as never,
      supervisor,
      processCronTasks: vi.fn().mockResolvedValue(undefined),
      processScheduleEntries: vi.fn().mockResolvedValue(undefined),
      proactiveTick: vi.fn().mockResolvedValue(undefined),
      saveDaemonState: saveSpy,
      state,
    });

    expect(saveSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toMatchObject({
      active_goals: ["goal-2"],
      status: "running",
    });
  });
});
