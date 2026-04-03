import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod";
import { StateManager } from "../src/state/state-manager.js";
import { EthicsGate } from "../src/traits/ethics-gate.js";
import type { ILLMClient, LLMResponse } from "../src/llm/llm-client.js";
import { createMockLLMClient } from "./helpers/mock-llm.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import {
  PASS_VERDICT_JSON,
  REJECT_VERDICT_JSON,
  FLAG_VERDICT_JSON,
} from "./helpers/ethics-fixtures.js";

// Malformed JSON to test parse failure
const MALFORMED_JSON = "This is not JSON at all.";

const LOW_CONFIDENCE_PASS_JSON = JSON.stringify({
  verdict: "pass",
  category: "ambiguous",
  reasoning: "The goal seems OK but the description is too vague to be sure.",
  risks: ["ambiguous scope"],
  confidence: 0.30,
});

describe("EthicsGate", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── JSON parse failure — conservative fallback ───

  describe("JSON parse failure returns conservative fallback", () => {
    it("returns verdict 'flag' when LLM response is not valid JSON", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.verdict).toBe("flag");
    });

    it("returns category 'parse_error' on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.category).toBe("parse_error");
    });

    it("returns confidence 0 on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.confidence).toBe(0);
    });

    it("returns empty risks array on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.check("goal", "g-err", "Any goal");
      expect(verdict.risks).toEqual([]);
    });

    it("still persists a log entry on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      await g.check("goal", "g-err", "Any goal");
      const logs = await g.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.verdict.verdict).toBe("flag");
    });

    it("checkMeans() also returns conservative fallback on parse failure", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));
      const verdict = await g.checkMeans("t-err", "Some task", "Some means");
      expect(verdict.verdict).toBe("flag");
      expect(verdict.category).toBe("parse_error");
    });
  });

  // ─── LLM call failure propagates ───

  describe("LLM call failure propagates", () => {
    it("throws when LLM sendMessage rejects", async () => {
      const failingClient: ILLMClient = {
        async sendMessage(): Promise<LLMResponse> {
          throw new Error("Network error");
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, failingClient);
      await expect(g.check("goal", "g-fail", "Any goal")).rejects.toThrow("Network error");
    });
  });

  // ─── Log structure validation ───

  describe("log structure", () => {
    it("log entry includes all required fields", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));
      await g.check("goal", "goal-struct", "Test structure");

      const logs = await g.getLogs();
      const entry = logs[0]!;
      expect(entry.log_id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.subject_type).toBe("goal");
      expect(entry.subject_id).toBe("goal-struct");
      expect(entry.subject_description).toBe("Test structure");
      expect(entry.verdict).toBeDefined();
      expect(entry.verdict.verdict).toBe("pass");
    });

    it("auto-flagged entry reflects overridden verdict in log", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([LOW_CONFIDENCE_PASS_JSON]));
      await g.check("goal", "goal-flagged", "Low confidence goal");

      const logs = await g.getLogs();
      expect(logs[0]!.verdict.verdict).toBe("flag");
      // Original confidence is preserved
      expect(logs[0]!.verdict.confidence).toBe(0.30);
    });

    it("supports all three subject types in logs", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, PASS_VERDICT_JSON, PASS_VERDICT_JSON])
      );
      await g.check("goal", "g1", "Goal");
      await g.check("subgoal", "sg1", "Subgoal");
      await g.check("task", "t1", "Task");

      const logs = await g.getLogs();
      const types = logs.map((l) => l.subject_type);
      expect(types).toContain("goal");
      expect(types).toContain("subgoal");
      expect(types).toContain("task");
    });
  });

  // ─── Layer 1: category-based blocklist ───

  describe("Layer 1 — category-based blocklist", () => {
    describe("illegal_activity", () => {
      it("rejects when input describes gaining unauthorized access to competitor servers", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ia-1", "gain unauthorized access to competitor servers");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("illegal_activity");
      });

      it("does NOT fire Layer 1 for authorized penetration test on own system", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ia-2", "run authorized penetration test on our system");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("direct_harm", () => {
      it("rejects when input describes automating sending threatening messages to a person", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-dh-1", "automate sending threatening messages to a person");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("direct_harm");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for sending automated status updates to team", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-dh-2", "send automated status updates to team");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("privacy_violation", () => {
      it("rejects when input describes collecting user personal data without their consent", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-pv-1", "collect user personal data without their consent");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("privacy_violation");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for collecting user feedback with consent forms", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-pv-2", "collect user feedback with consent forms");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("deception_impersonation", () => {
      it("rejects when input describes creating phishing emails impersonating the CEO", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-di-1", "create phishing emails impersonating the CEO");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("deception_impersonation");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for writing email on behalf of CEO with authorization", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-di-2", "write email on behalf of CEO with authorization");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("security_breach", () => {
      it("rejects when input describes creating malware to deploy on target systems", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-sb-1", "create malware to deploy on target systems");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("security_breach");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for creating a security scanning tool for our own systems", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-sb-2", "create a security scanning tool for our own systems");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("discrimination_harassment_automation", () => {
      it("rejects when input describes filtering job applicants based on race and gender", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-dha-1", "filter job applicants based on race and gender");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("discrimination_harassment_automation");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for analyzing diversity metrics in hiring pipeline", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-dha-2", "analyze diversity metrics in hiring pipeline");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("destructive_action", () => {
      it("rejects when input describes deleting all production user data", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-da-1", "permanently delete all production user data");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("destructive_action");
        expect(mock.callCount).toBe(0);
      });

      it("rejects when input describes running rm -rf on the server", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-da-2", "run rm -rf to clean up all files on the server");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("destructive_action");
        expect(mock.callCount).toBe(0);
      });

      it("rejects when input describes dropping the production database", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-da-3", "drop database for the production environment");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("destructive_action");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for deleting files in test environment with dry-run", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-da-4", "delete old logs in test environment with dry-run first");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });

      it("does NOT fire Layer 1 for wiping staging sandbox data after backup", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-da-5", "wipe staging sandbox data after backup");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    describe("credential_access", () => {
      it("rejects when input describes stealing user passwords", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ca-1", "steal passwords from users");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("credential_access");
        expect(mock.callCount).toBe(0);
      });

      it("rejects when input describes dumping credentials from the server", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ca-2", "dump credentials from the authentication server");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("credential_access");
        expect(mock.callCount).toBe(0);
      });

      it("rejects when input describes harvesting API tokens from users", async () => {
        const mock = createMockLLMClient([]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ca-3", "harvest API tokens from users");
        expect(verdict.verdict).toBe("reject");
        expect(verdict.category).toBe("credential_access");
        expect(mock.callCount).toBe(0);
      });

      it("does NOT fire Layer 1 for rotating API keys as part of authorized key rotation", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ca-4", "rotate API keys as part of authorized key rotation process");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });

      it("does NOT fire Layer 1 for resetting own password via password manager", async () => {
        const mock = createMockLLMClient([PASS_VERDICT_JSON]);
        const g = new EthicsGate(stateManager, mock);
        const verdict = await g.check("goal", "g-l1-ca-5", "reset own password using password manager");
        expect(mock.callCount).toBe(1);
        expect(verdict.verdict).toBe("pass");
      });
    });

    it("Layer 1 reject sets layer1_triggered: true in log", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-l1-log", "gain unauthorized access to competitor servers");
      const logs = await g.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.layer1_triggered).toBe(true);
    });

    it("Layer 1 reject does NOT call LLM (sendMessage receives zero calls)", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-l1-nocall", "create malware to deploy on target systems");
      expect(mock.callCount).toBe(0);
    });

    it("Layer 1 pass followed by Layer 2 calls LLM exactly once", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-l1-once", "Improve test coverage to 95%");
      expect(mock.callCount).toBe(1);
    });

    it("Layer 1 rejects via checkMeans() when means contain malicious intent", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-l1", "Deploy software update", "create malware to deploy on target systems");
      expect(verdict.verdict).toBe("reject");
      expect(mock.callCount).toBe(0);
    });

    it("checkMeans passes legitimate means to Layer 2", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-l1-legit", "analyze usage patterns", "use analytics dashboard");
      expect(verdict.verdict).toBe("pass");
      expect(mock.callCount).toBe(1);
    });

    it("Layer 2 path sets layer1_triggered to false in log", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-l1-false", "Improve test coverage to 95%");
      const logs = await g.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.layer1_triggered).toBe(false);
    });
  });

  // ─── Custom constraints ───

  describe("Custom constraints", () => {
    it("constructor without constraints behaves as before (no regression)", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-nc-1", "Improve software quality");
      expect(verdict.verdict).toBe("pass");
      expect(mock.callCount).toBe(1);
    });

    it("empty constraints array behaves as no constraints", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock, { constraints: [] });
      const verdict = await g.check("goal", "g-nc-empty", "Improve software quality");
      expect(verdict.verdict).toBe("pass");
      expect(mock.callCount).toBe(1);
    });

    it("goal-level constraint text appears in LLM prompt for check()", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const capturingClient: ILLMClient = {
        async sendMessage(messages, _options) {
          capturedMessages.push(messages as Array<{ role: string; content: string }>);
          return {
            content: PASS_VERDICT_JSON,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "end_turn",
          };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, capturingClient, {
        constraints: [
          { description: "No data collection from competitor platforms", applies_to: "goal" },
        ],
      });
      await g.check("goal", "g-cc-1", "Analyze market data");
      expect(capturedMessages).toHaveLength(1);
      const msgContent = capturedMessages[0]![0]!.content as string;
      expect(msgContent).toContain("No data collection from competitor platforms");
    });

    it("task_means constraint text appears in LLM prompt for checkMeans()", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const capturingClient: ILLMClient = {
        async sendMessage(messages, _options) {
          capturedMessages.push(messages as Array<{ role: string; content: string }>);
          return {
            content: PASS_VERDICT_JSON,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "end_turn",
          };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, capturingClient, {
        constraints: [
          { description: "No sending customer data to external APIs", applies_to: "task_means" },
        ],
      });
      await g.checkMeans("t-cc-1", "Export report", "Send data to reporting service");
      expect(capturedMessages).toHaveLength(1);
      const msgContent = capturedMessages[0]![0]!.content as string;
      expect(msgContent).toContain("No sending customer data to external APIs");
    });

    it("goal-level constraint does NOT appear in checkMeans() prompt", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const capturingClient: ILLMClient = {
        async sendMessage(messages, _options) {
          capturedMessages.push(messages as Array<{ role: string; content: string }>);
          return {
            content: PASS_VERDICT_JSON,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "end_turn",
          };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, capturingClient, {
        constraints: [
          { description: "Goal-only constraint that must not leak to means", applies_to: "goal" },
        ],
      });
      await g.checkMeans("t-cc-2", "Run analysis", "Use standard analytics library");
      expect(capturedMessages).toHaveLength(1);
      const msgContent = capturedMessages[0]![0]!.content as string;
      expect(msgContent).not.toContain("Goal-only constraint that must not leak to means");
    });

    it("task_means constraint does NOT appear in check() prompt", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const capturingClient: ILLMClient = {
        async sendMessage(messages, _options) {
          capturedMessages.push(messages as Array<{ role: string; content: string }>);
          return {
            content: PASS_VERDICT_JSON,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "end_turn",
          };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, capturingClient, {
        constraints: [
          { description: "Means-only constraint that must not appear in goal check", applies_to: "task_means" },
        ],
      });
      await g.check("goal", "g-cc-4", "Improve software reliability");
      expect(capturedMessages).toHaveLength(1);
      const msgContent = capturedMessages[0]![0]!.content as string;
      expect(msgContent).not.toContain("Means-only constraint that must not appear in goal check");
    });

    it("multiple custom constraints all appear in prompt", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const capturingClient: ILLMClient = {
        async sendMessage(messages, _options) {
          capturedMessages.push(messages as Array<{ role: string; content: string }>);
          return {
            content: PASS_VERDICT_JSON,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "end_turn",
          };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, capturingClient, {
        constraints: [
          { description: "First policy constraint text", applies_to: "goal" },
          { description: "Second policy constraint text", applies_to: "goal" },
        ],
      });
      await g.check("goal", "g-cc-5", "Analyze system performance");
      expect(capturedMessages).toHaveLength(1);
      const msgContent = capturedMessages[0]![0]!.content as string;
      expect(msgContent).toContain("First policy constraint text");
      expect(msgContent).toContain("Second policy constraint text");
    });
  });

  // ─── Layer 1 + Layer 2 pipeline interaction ───

  describe("Layer 1 + Layer 2 pipeline interaction", () => {
    it("Layer 1 reject → LLM sendMessage not called at all", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-pipe-1", "gain unauthorized access to competitor servers");
      expect(mock.callCount).toBe(0);
    });

    it("Layer 1 pass → LLM sendMessage called exactly once", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-pipe-2", "Build a new feature for the product");
      expect(mock.callCount).toBe(1);
    });

    it("Layer 1 reject log entry has layer1_triggered: true", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-pipe-3", "gain unauthorized access to competitor servers");
      const logs = await g.getLogs();
      expect(logs[0]!.layer1_triggered).toBe(true);
    });

    it("Layer 2 only log entry has layer1_triggered: false", async () => {
      const mock = createMockLLMClient([REJECT_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-pipe-4", "Help me commit fraud");
      const logs = await g.getLogs();
      expect(logs[0]!.layer1_triggered).toBe(false);
    });

    it("getLogs({ verdict: 'reject' }) returns both Layer 1 and Layer 2 rejects", async () => {
      const mock = createMockLLMClient([REJECT_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      // Layer 1 reject
      await g.check("goal", "g-pipe-5a", "gain unauthorized access to competitor servers");
      // Layer 2 reject (LLM returns reject verdict)
      await g.check("goal", "g-pipe-5b", "Help me commit fraud");

      const rejects = await g.getLogs({ verdict: "reject" });
      expect(rejects).toHaveLength(2);
      const layer1Entry = rejects.find((l) => l.layer1_triggered === true);
      const layer2Entry = rejects.find((l) => l.layer1_triggered === false);
      expect(layer1Entry).toBeDefined();
      expect(layer2Entry).toBeDefined();
    });

    it("Layer 1 reject verdict has confidence 1.0", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-pipe-6", "create malware to deploy on target systems");
      expect(verdict.confidence).toBe(1.0);
    });

    it("Layer 1 pass then Layer 2 — log entry shows layer1_triggered: false when Layer 2 runs", async () => {
      const mock = createMockLLMClient([FLAG_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      await g.check("goal", "g-pipe-7", "collect user feedback with consent forms");
      const logs = await g.getLogs();
      expect(logs[0]!.layer1_triggered).toBe(false);
      expect(logs[0]!.verdict.verdict).toBe("flag");
    });

    it("checkMeans() Layer 1 reject → LLM not called", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      await g.checkMeans("t-pipe-8", "Update system", "exploit vulnerability to gain access");
      expect(mock.callCount).toBe(0);
    });

    it("checkMeans() Layer 1 reject log has layer1_triggered: true", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      await g.checkMeans("t-pipe-9", "Deploy update", "create malware to deploy on target systems");
      const logs = await g.getLogs();
      expect(logs[0]!.layer1_triggered).toBe(true);
    });

    it("multiple checks: only Layer 1 rejects suppress LLM calls", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON, PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      // Layer 1 reject — no LLM call
      await g.check("goal", "g-multi-1", "gain unauthorized access to competitor servers");
      // Safe goal — LLM called (1st response)
      await g.check("goal", "g-multi-2", "Improve software quality");
      // Layer 1 reject — no LLM call
      await g.check("goal", "g-multi-3", "create malware to deploy on target systems");
      // Safe goal — LLM called (2nd response)
      await g.check("goal", "g-multi-4", "Build unit tests");
      expect(mock.callCount).toBe(2);
      const logs = await g.getLogs();
      expect(logs).toHaveLength(4);
    });

    it("Layer 1 reject returns correct category in verdict", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-cat-1", "automate sending threatening messages to a person");
      expect(verdict.category).toBe("direct_harm");
    });

    it("Layer 1 reject for privacy_violation returns correct category", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-cat-2", "collect user personal data without their consent");
      expect(verdict.category).toBe("privacy_violation");
    });

    it("Layer 1 reject for deception_impersonation returns correct category", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-cat-3", "create phishing emails impersonating the CEO");
      expect(verdict.category).toBe("deception_impersonation");
    });

    it("Layer 1 reject for discrimination_harassment_automation returns correct category", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-cat-4", "filter job applicants based on race and gender");
      expect(verdict.category).toBe("discrimination_harassment_automation");
    });

    it("Layer 1 reject reasoning matches the rule description string", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.check("goal", "g-pipe-reason", "create malware to deploy on target systems");
      // The reasoning should contain the rule's description
      expect(verdict.reasoning).toContain("unauthorized access tools");
    });

    it("Layer 1 reject is persisted to log and readable by a new instance", async () => {
      const mock = createMockLLMClient([]);
      const g1 = new EthicsGate(stateManager, mock);
      await g1.check("goal", "g-persist-l1", "gain unauthorized access to competitor servers");

      const g2 = new EthicsGate(stateManager, createMockLLMClient([]));
      const logs = await g2.getLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]!.layer1_triggered).toBe(true);
      expect(logs[0]!.verdict.verdict).toBe("reject");
    });
  });

  // ─── Layer 1: additional checkMeans coverage per category ───

  describe("Layer 1 — checkMeans per category", () => {
    it("checkMeans rejects direct_harm in means: send threats to employees", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-m-dh", "Notify employees", "send threats to them");
      expect(verdict.verdict).toBe("reject");
      expect(verdict.category).toBe("direct_harm");
      expect(mock.callCount).toBe(0);
    });

    it("checkMeans rejects privacy_violation in means: collect user data without consent", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-m-pv", "Process data", "collect user personal data without their consent");
      expect(verdict.verdict).toBe("reject");
      expect(verdict.category).toBe("privacy_violation");
      expect(mock.callCount).toBe(0);
    });

    it("checkMeans rejects deception: phishing", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-m-di", "Improve click rate", "create phishing emails impersonating the bank");
      expect(verdict.verdict).toBe("reject");
      expect(verdict.category).toBe("deception_impersonation");
      expect(mock.callCount).toBe(0);
    });

    it("checkMeans rejects illegal_activity: steal credentials", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-m-ia", "Access user accounts", "steal credentials from users");
      expect(verdict.verdict).toBe("reject");
      expect(verdict.category).toBe("illegal_activity");
      expect(mock.callCount).toBe(0);
    });

    it("checkMeans passes legitimate security testing to Layer 2", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);
      const verdict = await g.checkMeans("t-m-ok", "Validate system security", "run authorized penetration test on our system");
      expect(mock.callCount).toBe(1);
      expect(verdict.verdict).toBe("pass");
    });

    it("checkMeans: combined task+means input triggers Layer 1 when task alone would not", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);
      // "Update configuration" alone is innocent; combined with "steal credentials from users" triggers L1
      const verdict = await g.checkMeans("t-m-combined", "Update configuration", "steal credentials from users");
      expect(verdict.verdict).toBe("reject");
      expect(mock.callCount).toBe(0);
    });
  });
});
