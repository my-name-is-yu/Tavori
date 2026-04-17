/**
 * src/prompt/index.ts
 * Public API for the prompt module.
 */

export { PromptGateway } from "./gateway.js";
export type { IPromptGateway, PromptGatewayInput } from "./gateway.js";
export { ContextAssembler } from "./context-assembler.js";
export type { AssembledContext, ContextAssemblerDeps } from "./context-assembler.js";
export type { ContextPurpose, ContextSlot, MemoryLayer } from "./slot-definitions.js";
export { PURPOSE_CONFIGS } from "./purposes/index.js";
export * from "./purposes/index.js";
