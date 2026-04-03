import { z } from "zod";
import { StateManager } from "../state/state-manager.js";
import type { CapabilityDependency, CapabilityGap } from "../types/capability.js";

// ─── Constants ───

const DEPENDENCIES_PATH = "capability_dependencies.json";

// ─── Dependency Deps ───

export interface DependencyDeps {
  stateManager: StateManager;
}

// ─── loadDependencies ───

/**
 * Reads the capability dependency map from disk.
 * Returns an empty array if the file does not exist.
 */
export async function loadDependencies(deps: DependencyDeps): Promise<CapabilityDependency[]> {
  const raw = await deps.stateManager.readRaw(DEPENDENCIES_PATH);
  if (raw === null) {
    return [];
  }
  const parsed = z
    .array(z.object({ capability_id: z.string(), depends_on: z.array(z.string()) }))
    .safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// ─── saveDependencies ───

/**
 * Persists the dependency map to disk.
 */
export async function saveDependencies(deps: DependencyDeps, dependencies: CapabilityDependency[]): Promise<void> {
  await deps.stateManager.writeRaw(DEPENDENCIES_PATH, dependencies);
}

// ─── addDependency ───

/**
 * Records that capabilityId depends on the capabilities listed in dependsOn.
 * If an entry already exists for capabilityId, it is replaced.
 */
export async function addDependency(
  deps: DependencyDeps,
  capabilityId: string,
  dependsOn: string[]
): Promise<void> {
  const allDeps = await loadDependencies(deps);
  const existingIndex = allDeps.findIndex((d) => d.capability_id === capabilityId);
  const entry: CapabilityDependency = { capability_id: capabilityId, depends_on: dependsOn };
  if (existingIndex >= 0) {
    allDeps[existingIndex] = entry;
  } else {
    allDeps.push(entry);
  }
  await saveDependencies(deps, allDeps);
}

// ─── getDependencies ───

/**
 * Returns the list of capability IDs that the given capabilityId depends on.
 * Returns an empty array if no dependency entry exists.
 */
export async function getDependencies(deps: DependencyDeps, capabilityId: string): Promise<string[]> {
  const allDeps = await loadDependencies(deps);
  const entry = allDeps.find((d) => d.capability_id === capabilityId);
  return entry ? entry.depends_on : [];
}

// ─── resolveDependencies ───

/**
 * Performs a topological sort of the given capability dependencies using Kahn's algorithm.
 * Returns an ordered list of capability IDs with dependencies appearing before the
 * capabilities that depend on them.
 *
 * Capabilities referenced only as dependents (not appearing as `capability_id`) are
 * implicitly treated as roots and prepended to the sorted output.
 */
export function resolveDependencies(dependencies: CapabilityDependency[]): string[] {
  if (dependencies.length === 0) {
    return [];
  }

  // Collect all node IDs (both as keys and as dependency targets)
  const allIds = new Set<string>();
  for (const dep of dependencies) {
    allIds.add(dep.capability_id);
    for (const d of dep.depends_on) {
      allIds.add(d);
    }
  }

  // Build adjacency: dep.capability_id depends on dep.depends_on[i]
  // Topological order: dependency nodes come first
  // inDegree[node] = number of nodes that have `node` as a dependency target
  // Edge direction for Kahn's: dependency → dependent (dependency must come first)
  const inDegree = new Map<string, number>();
  // adjacency: from prerequisite → [nodes that depend on it]
  const adj = new Map<string, string[]>();

  for (const id of allIds) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const dep of dependencies) {
    for (const prereq of dep.depends_on) {
      // prereq must come before dep.capability_id
      // adj entries are initialized for all IDs in allIds (loop above)
      const adjList = adj.get(prereq);
      if (adjList) adjList.push(dep.capability_id);
      inDegree.set(dep.capability_id, (inDegree.get(dep.capability_id) ?? 0) + 1);
    }
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  // Sort queue for deterministic output
  queue.sort();

  const result: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    const neighbors = adj.get(node) ?? [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
        queue.sort();
      }
    }
  }

  return result;
}

// ─── detectCircularDependency ───

/**
 * Detects whether the given dependency list contains a circular dependency.
 * Returns the cycle as an array of capability IDs if found, or null if no cycle exists.
 */
export function detectCircularDependency(dependencies: CapabilityDependency[]): string[] | null {
  if (dependencies.length === 0) {
    return null;
  }

  // Build adjacency list: node → nodes it depends on
  const adj = new Map<string, string[]>();
  for (const dep of dependencies) {
    adj.set(dep.capability_id, dep.depends_on);
  }

  // DFS-based cycle detection with path tracking
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const stackPath: string[] = [];

  const dfs = (node: string): string[] | null => {
    if (inStack.has(node)) {
      // Found a cycle — extract the cycle path from stackPath
      const cycleStart = stackPath.indexOf(node);
      return [...stackPath.slice(cycleStart), node];
    }
    if (visited.has(node)) {
      return null;
    }

    visited.add(node);
    inStack.add(node);
    stackPath.push(node);

    const neighbors = adj.get(node) ?? [];
    for (const neighbor of neighbors) {
      const cycle = dfs(neighbor);
      if (cycle !== null) {
        return cycle;
      }
    }

    stackPath.pop();
    inStack.delete(node);
    return null;
  };

  for (const dep of dependencies) {
    if (!visited.has(dep.capability_id)) {
      const cycle = dfs(dep.capability_id);
      if (cycle !== null) {
        return cycle;
      }
    }
  }

  return null;
}

// ─── getAcquisitionOrder ───

/**
 * Reorders a list of CapabilityGaps so that capabilities with dependencies on
 * other gaps in the list come after those dependencies.
 * Independent capabilities (no deps in the list) maintain their original relative order.
 */
export async function getAcquisitionOrder(
  deps: DependencyDeps,
  gaps: CapabilityGap[]
): Promise<CapabilityGap[]> {
  if (gaps.length === 0) {
    return [];
  }

  const allDeps = await loadDependencies(deps);

  // Build a dependency list restricted to capabilities that appear in the gaps list
  const gapIds = new Set(gaps.map((g) => g.missing_capability.name));

  const relevantDeps: CapabilityDependency[] = [];
  for (const dep of allDeps) {
    if (gapIds.has(dep.capability_id)) {
      // Only include depends_on entries that are also in the gaps list
      const filteredDependsOn = dep.depends_on.filter((d) => gapIds.has(d));
      if (filteredDependsOn.length > 0) {
        relevantDeps.push({ capability_id: dep.capability_id, depends_on: filteredDependsOn });
      }
    }
  }

  if (relevantDeps.length === 0) {
    // No cross-gap dependencies — return original order
    return [...gaps];
  }

  const sortedIds = resolveDependencies(relevantDeps);

  // Gaps that appear in the sorted order are placed first (in sorted order),
  // gaps not in the sorted list (truly independent) maintain their relative original order.
  const inSortedSet = new Set(sortedIds);
  const independent = gaps.filter((g) => !inSortedSet.has(g.missing_capability.name));
  const dependent = sortedIds
    .map((id) => gaps.find((g) => g.missing_capability.name === id))
    .filter((g): g is CapabilityGap => g !== undefined);

  return [...independent, ...dependent];
}
