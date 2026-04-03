import { z } from "zod";
import { TaskSchema } from "./task.js";

export const TaskGroupSchema = z.object({
  subtasks: z.array(TaskSchema).min(2),
  dependencies: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
      })
    )
    .default([]),
  file_ownership: z.record(z.string(), z.array(z.string())).default({}),
  shared_context: z.string().optional(),
});
export type TaskGroup = z.infer<typeof TaskGroupSchema>;
