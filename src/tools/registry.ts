import type { ITool, ToolMetadata } from "./types.js";

/**
 * 3-tier tool registry.
 *
 * Tier 1 (Base Catalog): All registered tools. Static after initialization.
 * Tier 2 (Context-Filtered): Subset filtered by current goal context, trust level,
 *         and available capabilities. Recomputed when context changes.
 * Tier 3 (Assembled Pool): Final set of tools presented to the LLM, respecting
 *         context budget (token limit) and deferral rules.
 */
export class ToolRegistry {
  /** Tier 1: All registered tools */
  private baseCatalog: Map<string, ITool> = new Map();

  /** Alias -> canonical name mapping */
  private aliasMap: Map<string, string> = new Map();

  // --- Registration ---

  register(tool: ITool): void {
    const name = tool.metadata.name;
    if (this.baseCatalog.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    this.baseCatalog.set(name, tool);
    for (const alias of tool.metadata.aliases) {
      if (this.aliasMap.has(alias) || this.baseCatalog.has(alias)) {
        throw new Error(`Alias "${alias}" conflicts with existing tool or alias`);
      }
      this.aliasMap.set(alias, name);
    }
  }

  unregister(name: string): boolean {
    const tool = this.baseCatalog.get(name);
    if (!tool) return false;
    this.baseCatalog.delete(name);
    for (const alias of tool.metadata.aliases) {
      this.aliasMap.delete(alias);
    }
    return true;
  }

  // --- Lookup ---

  get(nameOrAlias: string): ITool | undefined {
    const canonical = this.aliasMap.get(nameOrAlias) ?? nameOrAlias;
    return this.baseCatalog.get(canonical);
  }

  listAll(): ITool[] {
    return [...this.baseCatalog.values()];
  }

  // --- Tier 2: Context Filtering ---

  filterByContext(filter: ContextFilter): ITool[] {
    return this.listAll().filter((tool) => {
      if (!this.isPermissionAllowed(tool.metadata, filter.trustBalance)) {
        return false;
      }
      if (
        filter.requiredTags &&
        filter.requiredTags.length > 0 &&
        !filter.requiredTags.some((tag) => tool.metadata.tags.includes(tag))
      ) {
        return false;
      }
      if (tool.metadata.shouldDefer && !filter.includeDeferred) {
        return false;
      }
      return true;
    });
  }

  // --- Tier 3: Assembly ---

  assemble(filter: ContextFilter, tokenBudget: number): AssembledPool {
    const filtered = this.filterByContext(filter);
    const alwaysLoad = filtered.filter((t) => t.metadata.alwaysLoad);
    const optional = filtered.filter((t) => !t.metadata.alwaysLoad);

    let usedTokens = 0;
    const included: ITool[] = [];
    const deferred: ITool[] = [];

    for (const tool of alwaysLoad) {
      const est = this.estimateTokens(tool, filter);
      included.push(tool);
      usedTokens += est;
    }

    const sorted = this.sortByRelevance(optional, filter);
    for (const tool of sorted) {
      const est = this.estimateTokens(tool, filter);
      if (usedTokens + est <= tokenBudget) {
        included.push(tool);
        usedTokens += est;
      } else {
        deferred.push(tool);
      }
    }

    return { included, deferred, usedTokens };
  }

  // --- Private Helpers ---

  private isPermissionAllowed(metadata: ToolMetadata, trustBalance: number): boolean {
    if (metadata.isReadOnly) return true;
    if (metadata.permissionLevel === "read_metrics") return trustBalance >= -50;
    return true;
  }

  private estimateTokens(tool: ITool, filter: ContextFilter): number {
    const desc = tool.description({ cwd: filter.cwd, goalId: filter.goalId });
    return Math.ceil((tool.metadata.name.length + desc.length) / 4) + 50;
  }

  private sortByRelevance(tools: ITool[], filter: ContextFilter): ITool[] {
    return [...tools].sort((a, b) => {
      const aScore = filter.requiredTags
        ? filter.requiredTags.filter((t) => a.metadata.tags.includes(t)).length
        : 0;
      const bScore = filter.requiredTags
        ? filter.requiredTags.filter((t) => b.metadata.tags.includes(t)).length
        : 0;
      return bScore - aScore;
    });
  }
}

// --- Supporting Types ---

export interface ContextFilter {
  trustBalance: number;
  requiredTags?: string[];
  includeDeferred?: boolean;
  cwd?: string;
  goalId?: string;
}

export interface AssembledPool {
  included: ITool[];
  deferred: ITool[];
  usedTokens: number;
}
