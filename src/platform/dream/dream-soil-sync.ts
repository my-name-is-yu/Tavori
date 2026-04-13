import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import { readJsonFileOrNull } from "../../base/utils/json-io.js";
import { AgentMemoryStoreSchema, type AgentMemoryEntry } from "../knowledge/types/agent-memory.js";
import { LearnedPatternSchema, type LearnedPattern } from "../knowledge/types/learning.js";
import type { SoilMutationInput, SoilRecord, SoilRecordFilterInput } from "../soil/contracts.js";
import { SqliteSoilRepository } from "../soil/sqlite-repository.js";
import { projectDreamKnowledgeToSoil, projectSoilFeedbackToSoil } from "../soil/content-projections.js";
import { loadSoilCompileMissObservations } from "../soil/feedback-store.js";
import { inspectSoilMemoryHealth } from "../soil/health.js";
import { loadDreamWorkflowRecords } from "./dream-event-workflows.js";
import { buildDreamSoilMutationIntent } from "./dream-soil-mutation.js";

export interface DreamSoilSyncRepository {
  loadRecords(filter?: SoilRecordFilterInput): Promise<SoilRecord[]>;
  applyMutation(mutation: SoilMutationInput): Promise<void>;
}

export interface DreamSoilSyncService {
  syncFromCurrentDreamState(input: {
    baseDir: string;
  }): Promise<DreamSoilSyncReport>;
}

export interface DreamSoilSyncReport {
  agentMemoryEntries: number;
  learnedPatterns: number;
  workflowRecords: number;
  previousRecords: number;
  recordsWritten: number;
  recordsSuperseded: number;
  chunksWritten: number;
  tombstonesWritten: number;
  recordsWithChangedSearchMaterial: number;
  queueReindexRecordIds: number;
  soilHealthFindings: number;
  soilCompileMissObservations: number;
}

export interface DreamSoilSyncInput {
  baseDir: string;
  repository: DreamSoilSyncRepository;
}

async function loadAgentMemoryEntries(baseDir: string): Promise<AgentMemoryEntry[]> {
  const raw = await readJsonFileOrNull(path.join(baseDir, "memory", "agent-memory", "entries.json"));
  if (raw === null) return [];
  const parsed = AgentMemoryStoreSchema.safeParse(raw);
  return parsed.success ? parsed.data.entries : [];
}

async function loadLearnedPatterns(baseDir: string): Promise<LearnedPattern[]> {
  const learningDir = path.join(baseDir, "learning");
  const entries = await fsp.readdir(learningDir).catch(() => [] as string[]);
  const patterns: LearnedPattern[] = [];
  for (const fileName of entries.filter((entry) => entry.endsWith("_patterns.json")).sort()) {
    const raw = await readJsonFileOrNull(path.join(learningDir, fileName));
    const parsed = z.array(LearnedPatternSchema).safeParse(raw);
    if (parsed.success) {
      patterns.push(...parsed.data);
    }
  }
  return patterns;
}

export async function syncDreamOutputsToSoil(input: DreamSoilSyncInput): Promise<DreamSoilSyncReport> {
  const [agentMemoryEntries, learnedPatterns, workflowRecords] = await Promise.all([
    loadAgentMemoryEntries(input.baseDir),
    loadLearnedPatterns(input.baseDir),
    loadDreamWorkflowRecords(input.baseDir),
  ]);
  const previousRecords = await input.repository.loadRecords({
    active_only: false,
    source_types: ["agent_memory", "learned_pattern", "dream_workflow"],
  });

  const intent = buildDreamSoilMutationIntent({
    agentMemoryEntries,
    learnedPatterns,
    workflowRecords,
    previousRecords,
  });

  const hasMutation =
    intent.mutation.records.length > 0 ||
    intent.mutation.chunks.length > 0 ||
    intent.mutation.tombstones.length > 0 ||
    intent.mutation.pages.length > 0 ||
    intent.mutation.page_members.length > 0 ||
    intent.mutation.embeddings.length > 0 ||
    intent.mutation.edges.length > 0;

  if (hasMutation) {
    await input.repository.applyMutation(intent.mutation);
  }
  await projectDreamKnowledgeToSoil({
    baseDir: input.baseDir,
    learnedPatterns,
    workflowRecords,
  });
  const compileMissObservations = await loadSoilCompileMissObservations({ baseDir: input.baseDir, limit: 500 });
  const healthSnapshot = await inspectSoilMemoryHealth({
    rootDir: path.join(input.baseDir, "soil"),
    compileMissObservations,
  });
  await projectSoilFeedbackToSoil({
    baseDir: input.baseDir,
    snapshot: healthSnapshot,
  });

  return {
    agentMemoryEntries: agentMemoryEntries.length,
    learnedPatterns: learnedPatterns.length,
    workflowRecords: workflowRecords.length,
    previousRecords: previousRecords.length,
    recordsWritten: intent.mutation.records.length,
    recordsSuperseded: intent.mutation.records.filter((record) => record.supersedes_record_id !== null).length,
    chunksWritten: intent.mutation.chunks.length,
    tombstonesWritten: intent.mutation.tombstones.length,
    recordsWithChangedSearchMaterial: intent.recordsWithChangedSearchMaterial.length,
    queueReindexRecordIds: intent.queueReindexRecordIds.length,
    soilHealthFindings: healthSnapshot.findingCount,
    soilCompileMissObservations: compileMissObservations.length,
  };
}

export function createDreamSoilSyncService(repository: DreamSoilSyncRepository): DreamSoilSyncService {
  return {
    syncFromCurrentDreamState: (input) => syncDreamOutputsToSoil({ ...input, repository }),
  };
}

export function createRuntimeDreamSoilSyncService(): DreamSoilSyncService {
  return {
    async syncFromCurrentDreamState(input) {
      const repository = await SqliteSoilRepository.create({ rootDir: path.join(input.baseDir, "soil") });
      try {
        return await syncDreamOutputsToSoil({ ...input, repository });
      } finally {
        repository.close();
      }
    },
  };
}
