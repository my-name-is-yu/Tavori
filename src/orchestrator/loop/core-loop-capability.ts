/**
 * core-loop-capability.ts
 *
 * Standalone capability acquisition functions extracted from CoreLoop.
 * These functions accept deps explicitly instead of using `this`.
 */

import type { Logger } from "../../runtime/logger.js";
import type { IAdapter } from "../execution/adapter-layer.js";
import type { CapabilityDetector } from "../../platform/observation/capability-detector.js";
import type { CapabilityAcquisitionTask } from "../../base/types/capability.js";

/** Handle the "capability_acquiring" action from TaskLifecycle.
 * Delegates acquisition to an adapter, verifies the result, and registers
 * the capability on success. Retries up to 3 times before escalating. */
export async function handleCapabilityAcquisition(
  acquisitionTask: CapabilityAcquisitionTask,
  goalId: string,
  adapter: IAdapter,
  capabilityDetector: CapabilityDetector | undefined,
  capabilityAcquisitionFailures: Map<string, number>,
  logger: Logger | undefined
): Promise<void> {
  if (!capabilityDetector) {
    logger?.warn("CoreLoop: capability_acquiring action received but no capabilityDetector configured — skipping");
    return;
  }

  const capName = acquisitionTask.gap.missing_capability.name;
  const capType = acquisitionTask.gap.missing_capability.type;

  logger?.info("CoreLoop: handling capability acquisition", { capName, capType, method: acquisitionTask.method });

  const prompt =
    `Capability Acquisition Task\n` +
    `Method: ${acquisitionTask.method}\n` +
    `Description: ${acquisitionTask.task_description}\n` +
    `Success criteria: ${acquisitionTask.success_criteria.join("; ")}\n\n` +
    `Instructions: Please acquire or set up the capability "${capName}" (${capType}). ` +
    `Follow the method "${acquisitionTask.method}" and ensure the success criteria are met.`;

  let agentResult;
  try {
    agentResult = await adapter.execute({ prompt, timeout_ms: 120000, adapter_type: adapter.adapterType });
  } catch (err) {
    logger?.error("CoreLoop: adapter execution failed during capability acquisition", {
      capName,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId, capabilityAcquisitionFailures, logger);
    return;
  }

  const capability = {
    id: capName.toLowerCase().replace(/\s+/g, "_"),
    name: capName,
    description: acquisitionTask.task_description,
    type: capType,
    status: "acquiring" as const,
  };

  let verificationResult;
  try {
    verificationResult = await capabilityDetector.verifyAcquiredCapability(
      capability,
      acquisitionTask,
      agentResult
    );
  } catch (err) {
    logger?.error("CoreLoop: capability verification threw an error", {
      capName,
      error: err instanceof Error ? err.message : String(err),
    });
    await recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId, capabilityAcquisitionFailures, logger);
    return;
  }

  if (verificationResult === "pass") {
    capabilityAcquisitionFailures.delete(capName);
    try {
      await capabilityDetector.registerCapability(capability, {
        goal_id: goalId,
        originating_task_id: acquisitionTask.gap.related_task_id,
        acquired_at: new Date().toISOString(),
      });
      await capabilityDetector.setCapabilityStatus(capName, capType, "available");
      logger?.info("CoreLoop: capability acquired and registered successfully", { capName });
    } catch (err) {
      logger?.error("CoreLoop: failed to register capability after verification pass", {
        capName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (verificationResult === "escalate") {
    capabilityAcquisitionFailures.delete(capName);
    await escalateCapability(capabilityDetector, acquisitionTask, goalId, logger);
  } else {
    await recordCapabilityFailure(capabilityDetector, acquisitionTask, goalId, capabilityAcquisitionFailures, logger);
  }
}

/** Records a capability acquisition failure and escalates after 3 consecutive failures. */
export async function recordCapabilityFailure(
  capabilityDetector: CapabilityDetector,
  acquisitionTask: CapabilityAcquisitionTask,
  goalId: string,
  capabilityAcquisitionFailures: Map<string, number>,
  logger: Logger | undefined
): Promise<void> {
  const capName = acquisitionTask.gap.missing_capability.name;
  const currentCount = (capabilityAcquisitionFailures.get(capName) ?? 0) + 1;
  capabilityAcquisitionFailures.set(capName, currentCount);

  logger?.warn("CoreLoop: capability acquisition failed", { capName, failureCount: currentCount });

  if (currentCount >= 3) {
    await escalateCapability(capabilityDetector, acquisitionTask, goalId, logger);
  }
}

/** Escalates a capability acquisition failure to the user and marks status as verification_failed. */
export async function escalateCapability(
  capabilityDetector: CapabilityDetector,
  acquisitionTask: CapabilityAcquisitionTask,
  goalId: string,
  logger: Logger | undefined
): Promise<void> {
  const capName = acquisitionTask.gap.missing_capability.name;
  const capType = acquisitionTask.gap.missing_capability.type;

  logger?.warn("CoreLoop: escalating capability acquisition to user", { capName });
  try {
    await capabilityDetector.escalateToUser(acquisitionTask.gap, goalId);
    await capabilityDetector.setCapabilityStatus(capName, capType, "verification_failed");
  } catch (err) {
    logger?.error("CoreLoop: escalation failed", {
      capName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
