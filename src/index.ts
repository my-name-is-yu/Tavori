// Motiva package entry point
// Re-exports core types and functions for programmatic use

export type { Goal, SessionResult, MotivaState } from './state.js';
export {
  initMotiva,
  readGoals,
  writeGoals,
  addGoal,
  updateGoal,
  readState,
  writeState,
  checkCompletion,
  detectStall,
} from './state.js';

export type { SessionOutput } from './adapters/claude-code.js';
export { runSession } from './adapters/claude-code.js';
