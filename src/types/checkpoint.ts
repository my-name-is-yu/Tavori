import { z } from 'zod';

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
