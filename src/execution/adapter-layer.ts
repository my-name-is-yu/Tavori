// ─── AdapterLayer ───
//
// Defines the IAdapter interface, AgentTask/AgentResult types, and
// AdapterRegistry for managing multiple adapter implementations.
// This is the abstraction layer that isolates TaskLifecycle from
// concrete agent implementations (Claude Code CLI, Claude API, etc.).

import { AdapterError } from "../utils/errors.js";

// ─── Types ───

export interface AgentTask {
  /** Session context + task instructions to pass to the agent */
  prompt: string;
  /** Timeout in milliseconds */
  timeout_ms: number;
  /** Which adapter to use for this task */
  adapter_type: string;
  /** Tool/capability allowlist — locked at task creation, immutable during execution */
  allowed_tools?: readonly string[];
}

export interface AgentResult {
  /** Whether the task completed without error or timeout */
  success: boolean;
  /** stdout from CLI / LLM response text */
  output: string;
  /** stderr / error message, null on success */
  error: string | null;
  /** Process exit code for CLI adapters; null for API adapters */
  exit_code: number | null;
  /** Wall-clock time from execute() call to resolution, in milliseconds */
  elapsed_ms: number;
  /** How execution ended */
  stopped_reason: "completed" | "timeout" | "error";
  /**
   * Whether the adapter actually modified any files, as detected by git diff --stat.
   * undefined = check was not performed (e.g., not a git repo, or adapter skipped).
   * true = files were changed; false = adapter reported success but no files changed.
   */
  filesChanged?: boolean;
}

// ─── Interface ───

export interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  /** Optional: return titles of existing tasks for dedup context injection into prompts. */
  listExistingTasks?(): Promise<string[]>;
  /** Optional: adapter-specific duplicate detection. Returns true if a duplicate exists. Fail-open: return false on error. */
  checkDuplicate?(task: AgentTask): Promise<boolean>;
  /**
   * Optional: format a prompt string from a task and optional workspace context.
   * When implemented, task-executor uses this instead of the default prompt builder.
   * Receives the raw Task (not AgentTask) so the adapter can access work_description etc.
   */
  formatPrompt?(task: import("../types/task.js").Task, workspaceContext?: string): string;
}

// ─── Circuit Breaker ───

type CircuitState = "closed" | "open" | "half_open";

interface CircuitBreaker {
  state: CircuitState;
  failure_count: number;
  last_failure_at: number; // Date.now()
  cooldown_ms: number;
}

const FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60_000;

// ─── AdapterRegistry ───

/**
 * Registry that maps adapter type strings to IAdapter instances.
 * Tracks per-adapter circuit breaker state for fault tolerance.
 */
export class AdapterRegistry {
  private readonly adapters: Map<string, IAdapter> = new Map();
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Register an adapter. Overwrites any previously registered adapter
   * for the same adapterType.
   */
  register(adapter: IAdapter): void {
    this.adapters.set(adapter.adapterType, adapter);
  }

  /**
   * Retrieve an adapter by type string.
   * Throws if no adapter is registered for that type.
   */
  getAdapter(type: string): IAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new AdapterError(
        `AdapterRegistry: no adapter registered for type "${type}". ` +
          `Available types: [${this.listAdapters().join(", ")}]`
      );
    }
    return adapter;
  }

  /**
   * Returns a sorted list of all registered adapter type strings.
   */
  listAdapters(): string[] {
    return Array.from(this.adapters.keys()).sort();
  }

  /**
   * Returns capabilities for all registered adapters.
   * For adapters without capabilities defined, returns ["general_purpose"] as default.
   */
  getAdapterCapabilities(): Array<{ adapterType: string; capabilities: string[] }> {
    return Array.from(this.adapters.entries()).map(([type, adapter]) => ({
      adapterType: type,
      capabilities: adapter.capabilities ? Array.from(adapter.capabilities) : ["general_purpose"],
    }));
  }

  // ─── Circuit Breaker Methods ───

  private getCircuitBreaker(adapterName: string): CircuitBreaker {
    if (!this.circuitBreakers.has(adapterName)) {
      this.circuitBreakers.set(adapterName, {
        state: "closed",
        failure_count: 0,
        last_failure_at: 0,
        cooldown_ms: DEFAULT_COOLDOWN_MS,
      });
    }
    return this.circuitBreakers.get(adapterName)!;
  }

  /** Reset failure count and set circuit to closed after a successful execution. */
  recordSuccess(adapterName: string): void {
    const cb = this.getCircuitBreaker(adapterName);
    cb.state = "closed";
    cb.failure_count = 0;
  }

  /** Increment failure count; open the circuit when threshold is reached. */
  recordFailure(adapterName: string): void {
    const cb = this.getCircuitBreaker(adapterName);
    cb.failure_count += 1;
    cb.last_failure_at = Date.now();
    if (cb.failure_count >= FAILURE_THRESHOLD) {
      cb.state = "open";
    }
  }

  /**
   * Returns false if the circuit is open and cooldown has not elapsed.
   * If cooldown has passed, transitions to half_open and returns true (probe attempt).
   */
  isAvailable(adapterName: string): boolean {
    const cb = this.getCircuitBreaker(adapterName);
    if (cb.state !== "open") {
      return true;
    }
    const elapsed = Date.now() - cb.last_failure_at;
    if (elapsed >= cb.cooldown_ms) {
      cb.state = "half_open";
      return true;
    }
    return false;
  }

  /** Returns the current circuit state for inspection/testing. */
  getCircuitState(adapterName: string): CircuitState {
    return this.getCircuitBreaker(adapterName).state;
  }

  // ─── Capability Matching ───

  /**
   * Finds the first registered adapter whose capabilities include ALL required strings.
   * Excludes the named adapter and any adapter whose circuit is open.
   * Returns the adapter name, or null if no match found.
   */
  selectByCapability(required: string[], excludeAdapter?: string): string | null {
    for (const [name, adapter] of this.adapters) {
      if (excludeAdapter !== undefined && name === excludeAdapter) {
        continue;
      }
      if (!this.isAvailable(name)) {
        continue;
      }
      const caps = adapter.capabilities ? Array.from(adapter.capabilities) : ["general_purpose"];
      const hasAll = required.every((r) => caps.includes(r));
      if (hasAll) {
        return name;
      }
    }
    return null;
  }
}
