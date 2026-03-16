import { z } from "zod";

// --- DataSourceType ---

export const DataSourceTypeEnum = z.enum(["file", "http_api", "database", "custom", "github_issue", "file_existence"]);
export type DataSourceType = z.infer<typeof DataSourceTypeEnum>;

// --- PollingConfig ---

export const PollingConfigSchema = z.object({
  interval_ms: z.number().min(30000),
  change_threshold: z.number().min(0).max(1).optional(),
});
export type PollingConfig = z.infer<typeof PollingConfigSchema>;

// --- DataSourceConfig ---

export const DataSourceConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: DataSourceTypeEnum,
  connection: z.object({
    path: z.string().optional(),
    url: z.string().optional(),
    method: z.enum(["GET", "POST"]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body_template: z.string().optional(),
    commands: z.record(z.string(), z.unknown()).optional(),
  }),
  polling: PollingConfigSchema.optional(),
  auth: z
    .object({
      type: z.enum(["none", "api_key", "basic", "bearer"]),
      secret_ref: z.string().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
  created_at: z.string(),
  dimension_mapping: z.record(z.string(), z.string()).optional(),
  scope_goal_id: z.string().optional(),
});
export type DataSourceConfig = z.infer<typeof DataSourceConfigSchema>;

// --- DataSourceQuery ---

export const DataSourceQuerySchema = z.object({
  dimension_name: z.string(),
  expression: z.string().optional(),
  timeout_ms: z.number().default(10000),
});
export type DataSourceQuery = z.infer<typeof DataSourceQuerySchema>;

// --- DataSourceResult ---

export const DataSourceResultSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean(), z.null()]),
  raw: z.unknown(),
  timestamp: z.string(),
  source_id: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type DataSourceResult = z.infer<typeof DataSourceResultSchema>;

// --- DataSourceRegistry ---

export const DataSourceRegistrySchema = z.object({
  sources: z.array(DataSourceConfigSchema),
});
export type DataSourceRegistry = z.infer<typeof DataSourceRegistrySchema>;
