/**
 * Server-side only — singleton instances of PulSeed core modules.
 * Route Handlers import this to access PulSeed data layer.
 */
import { StateManager } from '../../../dist/state-manager.js';
import { ReportingEngine } from '../../../dist/reporting-engine.js';

let stateManager: InstanceType<typeof StateManager> | null = null;
let reportingEngine: InstanceType<typeof ReportingEngine> | null = null;

export function getStateManager(): InstanceType<typeof StateManager> {
  if (!stateManager) {
    stateManager = new StateManager();
  }
  return stateManager;
}

export function getReportingEngine(): InstanceType<typeof ReportingEngine> {
  if (!reportingEngine) {
    reportingEngine = new ReportingEngine(getStateManager());
  }
  return reportingEngine;
}
