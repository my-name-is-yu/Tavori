// Re-export from tool-metadata for backward compatibility.
// New code should import from tool-metadata.ts directly.
export {
  ConfigKeyMeta,
  CONFIG_METADATA,
  buildConfigKeyDescription,
  buildConfigToolDescription,
  configChangeRequiresApproval,
  MutationToolMeta,
  MUTATION_TOOL_METADATA,
  buildMutationToolDescription,
} from "./tool-metadata.js";
