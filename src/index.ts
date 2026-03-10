export * from "./types/index.js";
export { StateManager } from "./state-manager.js";
export {
  computeRawGap,
  normalizeGap,
  applyConfidenceWeight,
  calculateDimensionGap,
  calculateGapVector,
  aggregateGaps,
} from "./gap-calculator.js";
export type { DimensionGapInput } from "./gap-calculator.js";
export { TrustManager } from "./trust-manager.js";
export { DriveSystem } from "./drive-system.js";
export {
  scoreDissatisfaction,
  scoreDeadline,
  scoreOpportunity,
  computeOpportunityValue,
  combineDriveScores,
  scoreAllDimensions,
  rankDimensions,
} from "./drive-scorer.js";
export { ObservationEngine } from "./observation-engine.js";
export { StallDetector } from "./stall-detector.js";
export { SatisficingJudge } from "./satisficing-judge.js";
