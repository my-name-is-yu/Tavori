import { StateManager } from "../state-manager.js";
import { ReportingEngine } from "../reporting-engine.js";
import {
  CapabilitySchema,
  CapabilityRegistrySchema,
  CapabilityGapSchema,
} from "../types/capability.js";
import type {
  Capability,
  CapabilityRegistry,
  CapabilityGap,
  CapabilityStatus,
  AcquisitionContext,
} from "../types/capability.js";
import type { Logger } from "../runtime/logger.js";

// ─── Constants ───

const REGISTRY_PATH = "capability_registry.json";

// ─── Registry Deps ───

export interface RegistryDeps {
  stateManager: StateManager;
}

export interface EscalateDeps {
  reportingEngine: ReportingEngine;
}

// ─── loadRegistry ───

/**
 * Reads capability registry from ~/.tavori/capability_registry.json.
 * Returns an empty registry if the file does not exist.
 */
export async function loadRegistry(deps: RegistryDeps): Promise<CapabilityRegistry> {
  const raw = await deps.stateManager.readRaw(REGISTRY_PATH);
  if (raw === null) {
    return CapabilityRegistrySchema.parse({
      capabilities: [],
      last_checked: new Date().toISOString(),
    });
  }
  return CapabilityRegistrySchema.parse(raw);
}

// ─── saveRegistry ───

/**
 * Persists the capability registry to disk.
 */
export async function saveRegistry(
  deps: RegistryDeps,
  registry: CapabilityRegistry
): Promise<void> {
  const parsed = CapabilityRegistrySchema.parse(registry);
  await deps.stateManager.writeRaw(REGISTRY_PATH, parsed);
}

// ─── registerCapability ───

/**
 * Adds a capability to the registry (or updates an existing one by id) and saves.
 * If context is provided, sets acquisition_context and acquired_at on the capability.
 */
export async function registerCapability(
  deps: RegistryDeps,
  cap: Capability,
  context?: AcquisitionContext
): Promise<void> {
  if (context !== undefined) {
    cap.acquisition_context = context;
    cap.acquired_at = context.acquired_at;
  }

  const parsed = CapabilitySchema.parse(cap);
  const registry = await loadRegistry(deps);

  const existingIndex = registry.capabilities.findIndex((c) => c.id === parsed.id);
  if (existingIndex >= 0) {
    registry.capabilities[existingIndex] = parsed;
  } else {
    registry.capabilities.push(parsed);
  }

  registry.last_checked = new Date().toISOString();
  await saveRegistry(deps, registry);
}

// ─── removeCapability ───

/**
 * Removes a capability from the registry by id and saves.
 */
export async function removeCapability(
  deps: RegistryDeps,
  capabilityId: string
): Promise<void> {
  const registry = await loadRegistry(deps);
  const before = registry.capabilities.length;
  registry.capabilities = registry.capabilities.filter((c) => c.id !== capabilityId);
  if (registry.capabilities.length === before) {
    throw new Error(`Capability with id "${capabilityId}" not found.`);
  }
  registry.last_checked = new Date().toISOString();
  await saveRegistry(deps, registry);
}

// ─── findCapabilityByName ───

/**
 * Finds the first capability in the registry matching the given name (case-insensitive).
 * Returns null if no match is found.
 */
export async function findCapabilityByName(
  deps: RegistryDeps,
  name: string
): Promise<Capability | null> {
  const registry = await loadRegistry(deps);
  const lowerName = name.toLowerCase();
  const found = registry.capabilities.find((c) => c.name.toLowerCase() === lowerName);
  return found ?? null;
}

// ─── getAcquisitionHistory ───

/**
 * Returns all AcquisitionContext entries for capabilities acquired in service of a given goal.
 */
export async function getAcquisitionHistory(
  deps: RegistryDeps,
  goalId: string
): Promise<AcquisitionContext[]> {
  const registry = await loadRegistry(deps);
  return registry.capabilities
    .filter(
      (c) =>
        c.acquisition_context !== undefined && c.acquisition_context.goal_id === goalId
    )
    .map((c) => c.acquisition_context as AcquisitionContext);
}

// ─── setCapabilityStatus ───

/**
 * Updates the status of a capability in the registry by name, or creates a
 * placeholder entry if no capability with that name exists yet.
 */
export async function setCapabilityStatus(
  deps: RegistryDeps,
  capabilityName: string,
  capabilityType: CapabilityGap["missing_capability"]["type"],
  status: CapabilityStatus
): Promise<void> {
  const registry = await loadRegistry(deps);
  const existing = registry.capabilities.find((c) => c.name === capabilityName);

  if (existing) {
    existing.status = status;
  } else {
    registry.capabilities.push(
      CapabilitySchema.parse({
        id: capabilityName.toLowerCase().replace(/\s+/g, "_"),
        name: capabilityName,
        description: "Auto-registered during acquisition flow",
        type: capabilityType,
        status,
      })
    );
  }

  registry.last_checked = new Date().toISOString();
  await saveRegistry(deps, registry);
}

// ─── escalateToUser ───

/**
 * Fires a capability_insufficient notification via ReportingEngine with a
 * structured message describing what is missing, why, alternatives, and impact.
 */
export async function escalateToUser(
  deps: EscalateDeps,
  gap: CapabilityGap,
  goalId: string,
  logger?: Logger
): Promise<void> {
  const capabilityName = gap.missing_capability.name;
  const capabilityType = gap.missing_capability.type;

  const alternativesList =
    gap.alternatives.length > 0
      ? gap.alternatives.map((a) => `- ${a}`).join("\n")
      : "_No alternatives identified._";

  const details =
    `**Missing Capability**: ${capabilityName} (${capabilityType})\n\n` +
    `**Why It Is Needed**: ${gap.reason}\n\n` +
    `**Alternatives**:\n${alternativesList}\n\n` +
    `**Impact If Unavailable**: ${gap.impact_description}` +
    (gap.related_task_id ? `\n\n**Related Task**: ${gap.related_task_id}` : "");

  try {
    await deps.reportingEngine.generateNotification(
      "capability_insufficient",
      {
        goalId,
        message: `Missing ${capabilityType}: ${capabilityName}`,
        details,
      }
    );
  } catch (err) {
    logger?.error(
      "[CapabilityDetector] escalateToUser: failed to save report — " +
        (err instanceof Error ? err.message : String(err))
    );
  }
}
