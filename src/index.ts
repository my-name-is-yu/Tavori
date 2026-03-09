// State models and manager
export { MotiveState, Goal, Gap, StateVectorElement, TrustBalance } from './state/models.js';
export { StateManager } from './state/manager.js';

// Engines
export { GapAnalysisEngine } from './engines/gap-analysis.js';
export { PriorityScoringEngine } from './engines/priority-scoring.js';
export { TaskGenerationEngine } from './engines/task-generation.js';
export { SatisficingEngine } from './engines/satisficing.js';
export { StallDetectionEngine } from './engines/stall-detection.js';

// Context injector
export { ContextInjector } from './context/injector.js';

// Hooks — reusable process functions (hook scripts also run as standalone CLIs)
export { processSessionStart } from './hooks/session-start.js';
export { processStop } from './hooks/stop.js';
export type { SessionStartInput, SessionStartResult } from './hooks/session-start.js';
export type { StopInput, StopResult, GoalSummary } from './hooks/stop.js';
