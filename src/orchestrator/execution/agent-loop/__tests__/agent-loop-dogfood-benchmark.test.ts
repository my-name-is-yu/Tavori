import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AgentLoopResult } from "../agent-loop-result.js";
import type { AgentLoopBudget } from "../agent-loop-budget.js";
import {
  assessTaskAgentLoopToolProfile,
  assessTaskAgentLoopToolProfileFromTools,
  nativeTaskAgentLoopToolProfile,
  runTaskAgentLoopDogfoodBenchmark,
  scoreTaskAgentLoopDogfoodResult,
} from "../agent-loop-dogfood-benchmark.js";
import type { TaskAgentLoopOutput } from "../task-agent-loop-result.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRequest,
  AgentLoopModelResponse,
} from "../agent-loop-model.js";
import { defaultAgentLoopCapabilities } from "../agent-loop-model.js";
import { StaticAgentLoopModelRegistry } from "../agent-loop-model-registry.js";
import { TaskAgentLoopRunner } from "../task-agent-loop-runner.js";
import { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import { createAgentLoopSession, type AgentLoopSession } from "../agent-loop-session.js";
import { ToolRegistryAgentLoopToolRouter } from "../agent-loop-tool-router.js";
import { ToolExecutorAgentLoopToolRuntime } from "../agent-loop-tool-runtime.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { createBuiltinTools } from "../../../../tools/builtin/index.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ApplyPatchTool } from "../../../../tools/fs/ApplyPatchTool/ApplyPatchTool.js";
import { ShellCommandTool } from "../../../../tools/system/ShellCommandTool/ShellCommandTool.js";
import type { Task } from "../../../../base/types/task.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

class ScriptedModelClient implements AgentLoopModelClient {
  calls: AgentLoopModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly modelInfo: AgentLoopModelInfo,
    private readonly responses: AgentLoopModelResponse[],
  ) {}

  async getModelInfo(): Promise<AgentLoopModelInfo> {
    return this.modelInfo;
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    this.calls.push(input);
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1]!;
  }
}

function makeResult(
  overrides: Partial<AgentLoopResult<TaskAgentLoopOutput>> = {},
): AgentLoopResult<TaskAgentLoopOutput> {
  return {
    success: true,
    output: {
      status: "done",
      finalAnswer: "done",
      summary: "changed code and verified it",
      filesChanged: ["src/foo.ts"],
      testsRun: [],
      completionEvidence: [],
      verificationHints: [],
      blockers: [],
    },
    finalText: "{}",
    stopReason: "completed",
    elapsedMs: 100,
    modelTurns: 2,
    toolCalls: 3,
    compactions: 0,
    filesChanged: true,
    changedFiles: ["src/foo.ts"],
    commandResults: [{
      toolName: "shell",
      command: "npx vitest run src/foo.test.ts",
      cwd: "/repo",
      success: true,
      category: "verification",
      evidenceEligible: true,
      relevantToTask: true,
      outputSummary: "pass",
      durationMs: 10,
    }],
    workspace: {
      requestedCwd: "/repo",
      executionCwd: "/repo-worktree",
      isolated: true,
      cleanupStatus: "kept",
    },
    traceId: "trace",
    sessionId: "session",
    turnId: "turn",
    ...overrides,
  };
}

describe("scoreTaskAgentLoopDogfoodResult", () => {
  it("passes a completed task with changed files, verification evidence, and isolated workspace", () => {
    const score = scoreTaskAgentLoopDogfoodResult(makeResult(), {
      mutationExpected: true,
      expectedChangedFiles: ["src/foo.ts"],
      requireIsolatedWorkspace: true,
      maxModelTurns: 5,
      maxToolCalls: 10,
    });

    expect(score.passed).toBe(true);
    expect(score.reasons).toEqual([]);
    expect(score.signals.successfulVerificationCommands).toBe(1);
    expect(score.signals.changedFiles).toEqual(["src/foo.ts"]);
  });

  it("fails when the task finishes without verification evidence", () => {
    const score = scoreTaskAgentLoopDogfoodResult(makeResult({ commandResults: [] }), {
      mutationExpected: true,
    });

    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("successful verification commands 0 < 1");
  });

  it("fails when failed verification commands are present", () => {
    const score = scoreTaskAgentLoopDogfoodResult(makeResult({
      commandResults: [{
        toolName: "shell",
        command: "npm test",
        cwd: "/repo",
        success: false,
        category: "verification",
        evidenceEligible: true,
        relevantToTask: true,
        outputSummary: "fail",
        durationMs: 10,
      }],
    }));

    expect(score.passed).toBe(false);
    expect(score.reasons).toContain("successful verification commands 0 < 1");
    expect(score.reasons.some((reason) => reason.includes("failed verification commands"))).toBe(true);
  });
});

describe("assessTaskAgentLoopToolProfile", () => {
  it("reports missing required tools separately from recommended tools", () => {
    const assessment = assessTaskAgentLoopToolProfile([
      "read",
      "grep",
      "glob",
      "list_dir",
      "apply_patch",
      "shell_command",
      "git_diff",
      "file_edit",
    ]);

    expect(assessment.ready).toBe(true);
    expect(assessment.missingRequiredToolNames).toEqual([]);
    expect(assessment.missingRecommendedToolNames).toEqual(
      nativeTaskAgentLoopToolProfile.recommendedToolNames.filter((name) => name !== "file_edit"),
    );
    expect(assessment.requiredCoverage).toBe(1);
    expect(assessment.recommendedCoverage).toBe(1 / nativeTaskAgentLoopToolProfile.recommendedToolNames.length);
  });

  it("passes the native task profile with the CLI builtin tool registry", () => {
    const registry = new ToolRegistry();
    const tools = createBuiltinTools({ registry });
    for (const tool of tools) {
      registry.register(tool);
    }

    const assessment = assessTaskAgentLoopToolProfileFromTools(registry.listAll());

    expect(assessment.ready).toBe(true);
    expect(assessment.missingRequiredToolNames).toEqual([]);
    expect(assessment.missingRecommendedToolNames).toEqual([]);
  });
});

describe("runTaskAgentLoopDogfoodBenchmark", () => {
  it("summarizes readiness across benchmark cases", async () => {
    const summary = await runTaskAgentLoopDogfoodBenchmark([
      {
        name: "passing-case",
        expectations: { mutationExpected: true, requireIsolatedWorkspace: true },
        run: async () => makeResult(),
      },
      {
        name: "missing-verification",
        expectations: { mutationExpected: true },
        run: async () => makeResult({ commandResults: [] }),
      },
    ]);

    expect(summary.totalCases).toBe(2);
    expect(summary.passedCases).toBe(1);
    expect(summary.passRate).toBe(0.5);
    expect(summary.ready).toBe(false);
    expect(summary.reasons.some((reason) => reason.includes("missing-verification"))).toBe(true);
  });

  it("scores a deterministic native TaskAgentLoop run with worktree diff and verification evidence", async () => {
    const repoDir = await createGitRepo();
    const worktreeBaseDir = path.join(path.dirname(repoDir), `${path.basename(repoDir)}.worktrees`);
    tempDirs.push(worktreeBaseDir);
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "call-1",
          name: "apply_patch",
          input: { patch: dogfoodPatch() },
        }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{
          id: "call-2",
          name: "shell_command",
          input: { command: "grep dogfood-ok dogfood.txt" },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Created dogfood.txt and verified dogfood-ok.",
          summary: "Added a dogfood marker file and verified it with grep.",
          filesChanged: ["dogfood.txt"],
          testsRun: [{ command: "grep dogfood-ok dogfood.txt", passed: true, outputSummary: "dogfood-ok" }],
          completionEvidence: ["verified command: grep dogfood-ok dogfood.txt"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const runner = makeTaskRunner(modelInfo, modelClient, repoDir);
    const summary = await runTaskAgentLoopDogfoodBenchmark([
      {
        name: "native-agentloop-worktree-edit",
        expectations: {
          mutationExpected: true,
          expectedChangedFiles: ["dogfood.txt"],
          requireIsolatedWorkspace: true,
          maxModelTurns: 4,
          maxToolCalls: 3,
        },
        run: () => runner.runTask({
          task: makeTask(),
          cwd: repoDir,
          worktreePolicy: {
            enabled: true,
            baseDir: worktreeBaseDir,
            cleanupPolicy: "always",
          },
        }),
      },
    ]);

    expect(summary.ready).toBe(true);
    expect(summary.passedCases).toBe(1);
    expect(summary.results[0]!.score.signals.changedFiles).toEqual(["dogfood.txt"]);
    expect(summary.results[0]!.score.signals.successfulVerificationCommands).toBe(1);
    expect(summary.results[0]!.result.workspace?.isolated).toBe(true);
    expect(fs.existsSync(path.join(repoDir, "dogfood.txt"))).toBe(false);
  });

  it("scores a read-only native TaskAgentLoop investigation without changed files", async () => {
    const repoDir = await createGitRepo({ readme: "dogfood repo\nread-only-marker\n" });
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "call-1",
          name: "shell_command",
          input: { command: "grep read-only-marker README.md" },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "README.md contains read-only-marker.",
          summary: "Confirmed the marker without editing files.",
          filesChanged: [],
          testsRun: [{ command: "grep read-only-marker README.md", passed: true, outputSummary: "read-only-marker" }],
          completionEvidence: ["verified command: grep read-only-marker README.md"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const runner = makeTaskRunner(modelInfo, modelClient, repoDir);
    const summary = await runTaskAgentLoopDogfoodBenchmark([
      {
        name: "native-agentloop-readonly-investigation",
        expectations: {
          mutationExpected: false,
          maxModelTurns: 3,
          maxToolCalls: 1,
        },
        run: () => runner.runTask({
          task: makeTask({
            work_description: "Verify README.md contains read-only-marker without changing files.",
            approach: "Run a focused read-only command, then return final JSON.",
            success_criteria: [{ description: "README.md contains read-only-marker", verification_method: "grep read-only-marker README.md", is_blocking: true }],
          }),
          cwd: repoDir,
        }),
      },
    ]);

    expect(summary.ready).toBe(true);
    expect(summary.results[0]!.score.signals.changedFiles).toEqual([]);
    expect(summary.results[0]!.score.signals.successfulVerificationCommands).toBe(1);
    expect(fs.readFileSync(path.join(repoDir, "README.md"), "utf-8")).toContain("read-only-marker");
  });

  it("scores failed verification recovery before final completion", async () => {
    const repoDir = await createGitRepo();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "apply_patch", input: { patch: dogfoodPatch("dogfood-bad") } }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "shell_command", input: { command: "grep dogfood-ok dogfood.txt" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Premature completion after failed verification.",
          summary: "This should be rejected by completion validation.",
          filesChanged: ["dogfood.txt"],
          testsRun: [{ command: "grep dogfood-ok dogfood.txt", passed: false, outputSummary: "no match" }],
          completionEvidence: ["claimed evidence"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "call-3", name: "apply_patch", input: { patch: dogfoodRepairPatch() } }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{ id: "call-4", name: "shell_command", input: { command: "grep dogfood-ok dogfood.txt" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Fixed dogfood.txt and verified dogfood-ok.",
          summary: "Recovered after failed verification.",
          filesChanged: ["dogfood.txt"],
          testsRun: [{ command: "grep dogfood-ok dogfood.txt", passed: true, outputSummary: "dogfood-ok" }],
          completionEvidence: ["verified command: grep dogfood-ok dogfood.txt"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const runner = makeTaskRunner(modelInfo, modelClient, repoDir, {
      defaultBudget: { maxModelTurns: 8, maxToolCalls: 6, maxCompletionValidationAttempts: 2 },
    });
    const summary = await runTaskAgentLoopDogfoodBenchmark([
      {
        name: "native-agentloop-verification-recovery",
        expectations: {
          mutationExpected: true,
          expectedChangedFiles: ["dogfood.txt"],
          allowFailedVerificationCommands: true,
          minSuccessfulVerificationCommands: 1,
          maxModelTurns: 6,
          maxToolCalls: 4,
        },
        run: () => runner.runTask({
          task: makeTask(),
          cwd: repoDir,
        }),
      },
    ]);

    expect(summary.ready).toBe(true);
    expect(summary.results[0]!.score.signals.failedVerificationCommands).toBe(1);
    expect(summary.results[0]!.score.signals.successfulVerificationCommands).toBe(1);
    expect(fs.readFileSync(path.join(repoDir, "dogfood.txt"), "utf-8")).toBe("dogfood-ok\n");
  });

  it("scores recovery across a denied command and failed verification before completion", async () => {
    const repoDir = await createGitRepo();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "apply_patch", input: { patch: dogfoodPatch("dogfood-bad") } }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "shell_command", input: { command: "cat dogfood.txt" } }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{ id: "call-3", name: "shell_command", input: { command: "grep dogfood-ok dogfood.txt" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Premature completion after one denied command and one failed grep.",
          summary: "This should be rejected because the runtime verification failed.",
          filesChanged: ["dogfood.txt"],
          testsRun: [{ command: "grep dogfood-ok dogfood.txt", passed: false, outputSummary: "no match" }],
          completionEvidence: [],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "call-4", name: "apply_patch", input: { patch: dogfoodRepairPatch() } }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{ id: "call-5", name: "shell_command", input: { command: "grep dogfood-ok dogfood.txt" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Recovered from denied/failed verification and verified dogfood-ok.",
          summary: "Fixed the file and verified it after the completion gate rejected premature success.",
          filesChanged: ["dogfood.txt"],
          testsRun: [{ command: "grep dogfood-ok dogfood.txt", passed: true, outputSummary: "dogfood-ok" }],
          completionEvidence: ["verified command: grep dogfood-ok dogfood.txt"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);

    const runner = makeTaskRunner(modelInfo, modelClient, repoDir, {
      defaultBudget: {
        maxModelTurns: 9,
        maxToolCalls: 8,
        maxConsecutiveToolErrors: 3,
        maxCompletionValidationAttempts: 2,
      },
      denyShellCommand: (command) => command === "cat dogfood.txt",
    });
    const summary = await runTaskAgentLoopDogfoodBenchmark([
      {
        name: "native-agentloop-denied-command-recovery",
        expectations: {
          mutationExpected: true,
          expectedChangedFiles: ["dogfood.txt"],
          allowFailedVerificationCommands: true,
          minSuccessfulVerificationCommands: 1,
          maxModelTurns: 7,
          maxToolCalls: 5,
        },
        run: () => runner.runTask({
          task: makeTask(),
          cwd: repoDir,
        }),
      },
    ]);

    expect(summary.ready).toBe(true);
    expect(summary.results[0]!.score.signals.failedVerificationCommands).toBe(1);
    expect(summary.results[0]!.score.signals.successfulVerificationCommands).toBe(1);
    expect(summary.results[0]!.result.commandResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: "cat dogfood.txt",
        success: false,
        category: "observation",
        evidenceEligible: false,
      }),
    ]));
    expect(fs.readFileSync(path.join(repoDir, "dogfood.txt"), "utf-8")).toBe("dogfood-ok\n");
  });

  it("scores a resumed native TaskAgentLoop after a tool-call budget stop", async () => {
    const repoDir = await createGitRepo();
    const modelInfo = makeModelInfo();
    const session = createAgentLoopSession();
    const firstModelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "apply_patch", input: { patch: resumePatch() } }],
        stopReason: "tool_use",
      },
    ]);
    const firstRunner = makeTaskRunner(modelInfo, firstModelClient, repoDir, {
      createSession: () => session,
      defaultBudget: { maxModelTurns: 4, maxToolCalls: 1 },
    });

    const task = makeTask({
      id: "resume-task",
      work_description: "Create resume.txt with resume-ok and verify it.",
      approach: "Patch the file, resume after interruption, verify the file, then finish.",
      success_criteria: [{ description: "resume.txt contains resume-ok", verification_method: "grep resume-ok resume.txt", is_blocking: true }],
      scope_boundary: { in_scope: ["resume.txt"], out_of_scope: [], blast_radius: "low" },
    });

    const interrupted = await firstRunner.runTask({ task, cwd: repoDir });
    expect(interrupted.success).toBe(false);
    expect(interrupted.stopReason).toBe("max_tool_calls");

    const secondModelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "shell_command", input: { command: "grep resume-ok resume.txt" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Resumed and verified resume.txt.",
          summary: "Completed after resuming from saved AgentLoop state.",
          filesChanged: ["resume.txt"],
          testsRun: [{ command: "grep resume-ok resume.txt", passed: true, outputSummary: "resume-ok" }],
          completionEvidence: ["verified command: grep resume-ok resume.txt"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const secondRunner = makeTaskRunner(modelInfo, secondModelClient, repoDir, {
      createSession: () => session,
      defaultBudget: { maxModelTurns: 4, maxToolCalls: 4 },
    });

    const summary = await runTaskAgentLoopDogfoodBenchmark([
      {
        name: "native-agentloop-resume",
        expectations: {
          mutationExpected: true,
          expectedChangedFiles: ["resume.txt"],
          minSuccessfulVerificationCommands: 1,
          maxModelTurns: 3,
          maxToolCalls: 2,
        },
        run: () => secondRunner.runTask({ task, cwd: repoDir }),
      },
    ]);

    expect(summary.ready).toBe(true);
    expect(summary.results[0]!.score.signals.successfulVerificationCommands).toBe(1);
    expect(fs.readFileSync(path.join(repoDir, "resume.txt"), "utf-8")).toBe("resume-ok\n");
  }, 20_000);
});

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "dogfood" },
    displayName: "test/dogfood",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeTaskRunner(
  modelInfo: AgentLoopModelInfo,
  modelClient: AgentLoopModelClient,
  cwd: string,
  options: {
    createSession?: () => AgentLoopSession;
    defaultBudget?: Partial<AgentLoopBudget>;
    denyShellCommand?: (command: string) => boolean;
  } = {},
): TaskAgentLoopRunner {
  const registry = new ToolRegistry();
  registry.register(new ApplyPatchTool());
  registry.register(new ShellCommandTool());
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({
      denyRules: options.denyShellCommand
        ? [{
            toolName: "shell_command",
            inputMatcher: (input) =>
              input !== null
              && typeof input === "object"
              && typeof (input as Record<string, unknown>)["command"] === "string"
              && options.denyShellCommand!((input as Record<string, string>)["command"]),
            reason: "dogfood denied shell command",
          }]
        : [],
      allowRules: [{ toolName: "shell_command", reason: "dogfood benchmark verification command" }],
    }),
    concurrency: new ConcurrencyController(),
  });
  const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
  const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

  return new TaskAgentLoopRunner({
    boundedRunner,
    modelClient,
    modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
    defaultModel: modelInfo.ref,
    defaultToolPolicy: {
      allowedTools: ["apply_patch", "shell_command"],
    },
    defaultBudget: {
      maxModelTurns: 5,
      maxToolCalls: 5,
      maxCompletionValidationAttempts: 1,
      ...options.defaultBudget,
    },
    cwd,
    ...(options.createSession ? { createSession: options.createSession } : {}),
  });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "dogfood-task",
    goal_id: "dogfood-goal",
    strategy_id: null,
    target_dimensions: ["execution"],
    primary_dimension: "execution",
    work_description: "Create dogfood.txt with the text dogfood-ok and verify it.",
    rationale: "Exercise native AgentLoop worktree diff and verification evidence.",
    approach: "Patch the file, run a focused verification command, then return final JSON.",
    success_criteria: [{ description: "dogfood.txt contains dogfood-ok", verification_method: "grep dogfood-ok dogfood.txt", is_blocking: true }],
    scope_boundary: { in_scope: ["dogfood.txt"], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "minutes" },
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

function dogfoodPatch(value = "dogfood-ok"): string {
  return [
    "diff --git a/dogfood.txt b/dogfood.txt",
    "new file mode 100644",
    "index 0000000..7b6b304",
    "--- /dev/null",
    "+++ b/dogfood.txt",
    "@@ -0,0 +1 @@",
    `+${value}`,
    "",
  ].join("\n");
}

function dogfoodRepairPatch(): string {
  return [
    "diff --git a/dogfood.txt b/dogfood.txt",
    "index 7b6b304..3d7e4aa 100644",
    "--- a/dogfood.txt",
    "+++ b/dogfood.txt",
    "@@ -1 +1 @@",
    "-dogfood-bad",
    "+dogfood-ok",
    "",
  ].join("\n");
}

function resumePatch(): string {
  return [
    "diff --git a/resume.txt b/resume.txt",
    "new file mode 100644",
    "index 0000000..7b6b304",
    "--- /dev/null",
    "+++ b/resume.txt",
    "@@ -0,0 +1 @@",
    "+resume-ok",
    "",
  ].join("\n");
}

async function createGitRepo(input: { readme?: string } = {}): Promise<string> {
  const repoDir = makeTempDir();
  tempDirs.push(repoDir);
  await fsp.writeFile(path.join(repoDir, "README.md"), input.readme ?? "dogfood repo\n", "utf-8");
  await run("git", ["init"], repoDir);
  await run("git", ["config", "user.email", "test@example.com"], repoDir);
  await run("git", ["config", "user.name", "Test"], repoDir);
  await run("git", ["add", "README.md"], repoDir);
  await run("git", ["commit", "-m", "init"], repoDir);
  return repoDir;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stderr = "";
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} failed`)));
  });
}
