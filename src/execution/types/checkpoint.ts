import { z } from 'zod';

/**
 * Loop-level crash-recovery checkpoint (§4.8).
 * Distinct from CheckpointSchema, which handles multi-agent session transfer.
 */
export const LoopCheckpointSchema = z.object({
  cycle_number: z.number().int().nonnegative(),
  last_verified_task_id: z.string().optional(),
  dimension_snapshot: z.record(z.string(), z.number()).optional(),
  trust_snapshot: z.number().optional(),
  timestamp: z.string().optional(),
});
export type LoopCheckpoint = z.infer<typeof LoopCheckpointSchema>;

export const CheckpointMetadataSchema = z.object({
  strategy_id: z.string().optional(),
  iteration_count: z.number().optional(),
  gap_value: z.number().optional(),
  adapter_type: z.string().optional(),
});
export type CheckpointMetadata = z.infer<typeof CheckpointMetadataSchema>;

export const CheckpointSchema = z.object({
  checkpoint_id: z.string(),
  goal_id: z.string(),
  task_id: z.string(),
  agent_id: z.string(),
  session_context_snapshot: z.string(),
  intermediate_results: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  metadata: CheckpointMetadataSchema.default({}),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const CheckpointIndexSchema = z.object({
  goal_id: z.string(),
  checkpoints: z.array(z.object({
    checkpoint_id: z.string(),
    task_id: z.string(),
    agent_id: z.string(),
    created_at: z.string().datetime(),
  })).default([]),
});
export type CheckpointIndex = z.infer<typeof CheckpointIndexSchema>;
