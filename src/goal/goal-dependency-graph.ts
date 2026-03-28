import { z } from "zod";
import { ValidationError } from "../utils/errors.js";
import type { StateManager } from "../state-manager.js";
import type { ILLMClient, LLMMessage } from "../llm/llm-client.js";
import type {
  DependencyEdge,
  DependencyEdgeStatus,
  DependencyGraph,
} from "../types/dependency.js";
import { DependencyGraphSchema } from "../types/dependency.js";
import type { DependencyType } from "../types/core.js";
import type { IPromptGateway } from "../prompt/gateway.js";

const AutoDetectItemSchema = z.object({
  from_goal_id: z.string(),
  to_goal_id: z.string(),
  type: z.enum(["prerequisite", "resource_conflict", "synergy", "conflict"]),
  condition: z.string().nullable().optional(),
  affected_dimensions: z.array(z.string()).optional(),
  reasoning: z.string().nullable().optional(),
  detection_confidence: z.number().min(0).max(1).optional(),
});

const AutoDetectResponseSchema = z.array(AutoDetectItemSchema);

/**
 * GoalDependencyGraph manages a DAG of dependencies between goals.
 *
 * Supports 4 edge types:
 *   - prerequisite: goal A must complete before goal B can start
 *   - resource_conflict: goals A and B compete for the same resource
 *   - synergy: progress on goal A helps goal B
 *   - conflict: goals A and B have incompatible objectives
 *
 * Persistence: ~/.pulseed/dependency-graph.json (via StateManager.readRaw/writeRaw)
 */
export class GoalDependencyGraph {
  private stateManager: StateManager;
  private llmClient?: ILLMClient;
  private promptGateway?: IPromptGateway;
  private graph: DependencyGraph;

  constructor(stateManager: StateManager, llmClient?: ILLMClient, promptGateway?: IPromptGateway) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.promptGateway = promptGateway;
    this.graph = { nodes: [], edges: [], updated_at: new Date().toISOString() };
  }

  /**
   * Initializes the graph from disk. Must be called after construction when
   * StateManager async methods are available.
   */
  async init(): Promise<void> {
    this.graph = await this.load();
  }

  // ─── CRUD ───

  /**
   * Adds an edge to the graph.
   * For prerequisite edges, validates that the addition would not create a cycle.
   */
  async addEdge(edge: Omit<DependencyEdge, "created_at">): Promise<DependencyEdge> {
    if (edge.type === "prerequisite" && this.detectCycle(edge.from_goal_id, edge.to_goal_id)) {
      throw new ValidationError(
        `Adding prerequisite ${edge.from_goal_id} → ${edge.to_goal_id} would create a cycle`
      );
    }

    const fullEdge: DependencyEdge = {
      ...edge,
      created_at: new Date().toISOString(),
    };

    // Add nodes if not present
    if (!this.graph.nodes.includes(edge.from_goal_id)) {
      this.graph.nodes.push(edge.from_goal_id);
    }
    if (!this.graph.nodes.includes(edge.to_goal_id)) {
      this.graph.nodes.push(edge.to_goal_id);
    }

    this.graph.edges.push(fullEdge);
    this.graph.updated_at = new Date().toISOString();
    await this.save(this.graph);
    return fullEdge;
  }

  /**
   * Removes an edge matching from/to/type from the graph.
   */
  async removeEdge(fromGoalId: string, toGoalId: string, type: DependencyType): Promise<void> {
    this.graph.edges = this.graph.edges.filter(
      (e) =>
        !(
          e.from_goal_id === fromGoalId &&
          e.to_goal_id === toGoalId &&
          e.type === type
        )
    );
    this.graph.updated_at = new Date().toISOString();
    await this.save(this.graph);
  }

  /**
   * Updates the status of an edge identified by from/to.
   */
  async updateEdgeStatus(
    fromGoalId: string,
    toGoalId: string,
    status: DependencyEdgeStatus
  ): Promise<void> {
    const edge = this.getEdge(fromGoalId, toGoalId);
    if (edge) {
      edge.status = status;
      this.graph.updated_at = new Date().toISOString();
      await this.save(this.graph);
    }
  }

  /**
   * Returns all edges where goalId appears as either from or to.
   */
  getEdges(goalId: string): DependencyEdge[] {
    return this.graph.edges.filter(
      (e) => e.from_goal_id === goalId || e.to_goal_id === goalId
    );
  }

  /**
   * Returns the first edge matching from/to (and optionally type), or null.
   */
  getEdge(
    fromGoalId: string,
    toGoalId: string,
    type?: DependencyType
  ): DependencyEdge | null {
    return (
      this.graph.edges.find(
        (e) =>
          e.from_goal_id === fromGoalId &&
          e.to_goal_id === toGoalId &&
          (!type || e.type === type)
      ) ?? null
    );
  }

  // ─── DAG Validation ───

  /**
   * Detects whether adding a prerequisite edge from→to would create a cycle.
   *
   * Uses BFS starting from "to" following active prerequisite edges.
   * If we can reach "from", adding from→to would form a cycle.
   */
  detectCycle(fromGoalId: string, toGoalId: string): boolean {
    const visited = new Set<string>();
    const queue: string[] = [toGoalId];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current === fromGoalId) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      // Follow active prerequisite edges where current is the from_goal_id
      for (const edge of this.graph.edges) {
        if (
          edge.type === "prerequisite" &&
          edge.from_goal_id === current &&
          edge.status === "active"
        ) {
          queue.push(edge.to_goal_id);
        }
      }
    }

    return false;
  }

  // ─── Scheduling Influence ───

  /**
   * Returns active prerequisite edges that must be satisfied before goalId can proceed.
   */
  getPrerequisites(goalId: string): DependencyEdge[] {
    return this.graph.edges.filter(
      (e) =>
        e.to_goal_id === goalId &&
        e.type === "prerequisite" &&
        e.status === "active"
    );
  }

  /**
   * Returns true if goalId has unresolved prerequisites.
   */
  isBlocked(goalId: string): boolean {
    return this.getPrerequisites(goalId).length > 0;
  }

  /**
   * Returns the IDs of goals that must complete before goalId can proceed.
   */
  getBlockingGoals(goalId: string): string[] {
    return this.getPrerequisites(goalId).map((e) => e.from_goal_id);
  }

  /**
   * Returns active resource_conflict edges involving goalId.
   */
  getResourceConflicts(goalId: string): DependencyEdge[] {
    return this.graph.edges.filter(
      (e) =>
        e.type === "resource_conflict" &&
        e.status === "active" &&
        (e.from_goal_id === goalId || e.to_goal_id === goalId)
    );
  }

  /**
   * Returns goal IDs that have a synergy relationship with goalId.
   */
  getSynergyPartners(goalId: string): string[] {
    return this.graph.edges
      .filter(
        (e) =>
          e.type === "synergy" &&
          e.status === "active" &&
          (e.from_goal_id === goalId || e.to_goal_id === goalId)
      )
      .map((e) =>
        e.from_goal_id === goalId ? e.to_goal_id : e.from_goal_id
      );
  }

  // ─── LLM Auto-detection ───

  /**
   * Uses an LLM to automatically detect dependency relationships between a new goal
   * and a set of existing goals. Detected dependencies are added to the graph.
   *
   * Returns an empty array if no LLM client is configured or no existing goals are provided.
   */
  async autoDetectDependencies(
    newGoalId: string,
    existingGoalIds: string[]
  ): Promise<DependencyEdge[]> {
    if ((!this.llmClient && !this.promptGateway) || existingGoalIds.length === 0) return [];

    const prompt = `Analyze dependencies between a new goal and existing goals.

New goal ID: ${newGoalId}
Existing goal IDs: ${existingGoalIds.join(", ")}

For each relationship found, return a JSON array of objects with:
- from_goal_id: string
- to_goal_id: string
- type: "prerequisite" | "resource_conflict" | "synergy" | "conflict"
- condition: string or null (when is this dependency satisfied?)
- affected_dimensions: string[] (which dimensions are affected)
- reasoning: string (why this dependency exists)
- detection_confidence: number 0-1

Return empty array [] if no dependencies found.`;

    try {
      let rawData: unknown;
      if (this.promptGateway) {
        rawData = await this.promptGateway.execute({
          purpose: "goal_decomposition",
          goalId: newGoalId,
          additionalContext: { dependency_prompt: prompt },
          responseSchema: AutoDetectResponseSchema,
        });
      } else {
        const messages: LLMMessage[] = [{ role: "user", content: prompt }];
        const response = await this.llmClient!.sendMessage(messages);
        rawData = JSON.parse(response.content);
      }
      const parsed = AutoDetectResponseSchema.safeParse(rawData);
      if (!parsed.success) {
        console.warn(
          `autoDetectDependencies: LLM response failed Zod validation — ${parsed.error.message}`
        );
        return [];
      }

      const edges: DependencyEdge[] = [];
      for (const item of parsed.data) {
        try {
          const edge = await this.addEdge({
            from_goal_id: item.from_goal_id,
            to_goal_id: item.to_goal_id,
            type: item.type as DependencyType,
            status: "active",
            condition: item.condition ?? null,
            affected_dimensions: item.affected_dimensions ?? [],
            mitigation: null,
            detection_confidence: item.detection_confidence ?? 0.5,
            reasoning: item.reasoning ?? null,
          });
          edges.push(edge);
        } catch {
          // Skip items that fail addEdge (e.g. duplicate edges)
        }
      }
      return edges;
    } catch {
      return [];
    }
  }

  // ─── Strategy Dependencies ───

  /**
   * Add a strategy-level dependency between two strategies.
   * Uses DependencyType "strategy_dependency" for the underlying edge.
   * The sourceStrategyId is stored in from_goal_id and targetStrategyId in to_goal_id.
   */
  async addStrategyDependency(
    sourceStrategyId: string,
    targetStrategyId: string,
    dependencyType: "prerequisite" | "enhances",
    goalId: string
  ): Promise<void> {
    await this.addEdge({
      from_goal_id: sourceStrategyId,
      to_goal_id: targetStrategyId,
      type: "strategy_dependency",
      status: "active",
      condition: null,
      affected_dimensions: [],
      mitigation: null,
      detection_confidence: 1.0,
      reasoning: `strategy_dependency_type:${dependencyType};goal_id:${goalId}`,
    });
  }

  /**
   * Get all strategy dependencies for a given strategy.
   * Returns edges where this strategy is either source or target.
   */
  getStrategyDependencies(strategyId: string): Array<{
    source_strategy_id: string;
    target_strategy_id: string;
    dependency_type: "prerequisite" | "enhances";
    goal_id: string;
  }> {
    return this.graph.edges
      .filter(
        (e) =>
          e.type === "strategy_dependency" &&
          (e.from_goal_id === strategyId || e.to_goal_id === strategyId)
      )
      .map((e) => {
        // Extract dependency_type and goal_id from the reasoning field
        const reasoning = e.reasoning ?? "";
        const dtMatch = reasoning.match(/strategy_dependency_type:(prerequisite|enhances)/);
        const giMatch = reasoning.match(/goal_id:([^;]+)/);
        return {
          source_strategy_id: e.from_goal_id,
          target_strategy_id: e.to_goal_id,
          dependency_type: (dtMatch?.[1] ?? "prerequisite") as "prerequisite" | "enhances",
          goal_id: giMatch?.[1] ?? "",
        };
      });
  }

  /**
   * Check if a strategy is blocked by a prerequisite dependency.
   * Returns true if the strategy has a prerequisite dependency where
   * the source strategy is NOT in completedStrategyIds.
   */
  isStrategyBlocked(strategyId: string, completedStrategyIds: string[]): boolean {
    const deps = this.getStrategyDependencies(strategyId);
    return deps.some(
      (d) =>
        d.dependency_type === "prerequisite" &&
        d.target_strategy_id === strategyId &&
        !completedStrategyIds.includes(d.source_strategy_id)
    );
  }

  // ─── Persistence ───

  /**
   * Loads the dependency graph from disk.
   * Returns an empty graph if no file exists or parsing fails.
   */
  async load(): Promise<DependencyGraph> {
    try {
      const raw = await this.stateManager.readRaw("dependency-graph.json");
      if (raw !== null) {
        return DependencyGraphSchema.parse(raw);
      }
    } catch {
      // ignore parse errors — start fresh
    }
    return { nodes: [], edges: [], updated_at: new Date().toISOString() };
  }

  /**
   * Persists the dependency graph to disk.
   */
  async save(graph: DependencyGraph): Promise<void> {
    await this.stateManager.writeRaw("dependency-graph.json", graph);
  }

  /**
   * Returns the current in-memory graph.
   */
  getGraph(): DependencyGraph {
    return this.graph;
  }
}
