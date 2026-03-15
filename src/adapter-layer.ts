// ─── AdapterLayer ───
//
// Defines the IAdapter interface, AgentTask/AgentResult types, and
// AdapterRegistry for managing multiple adapter implementations.
// This is the abstraction layer that isolates TaskLifecycle from
// concrete agent implementations (Claude Code CLI, Claude API, etc.).

// ─── Types ───

export interface AgentTask {
  /** Session context + task instructions to pass to the agent */
  prompt: string;
  /** Timeout in milliseconds */
  timeout_ms: number;
  /** Which adapter to use for this task */
  adapter_type: string;
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
}

// ─── Interface ───

export interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  /** Optional: return titles of existing tasks for dedup context injection into prompts. */
  listExistingTasks?(): Promise<string[]>;
}

// ─── AdapterRegistry ───

/**
 * Registry that maps adapter type strings to IAdapter instances.
 * AdapterRegistry itself is stateless beyond the map.
 */
export class AdapterRegistry {
  private readonly adapters: Map<string, IAdapter> = new Map();

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
      throw new Error(
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
}
