import type { Logger } from "../../../runtime/logger.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import { getReflectionsForGoal, formatReflectionsForPrompt } from "../reflection-generator.js";

interface BuildEnrichedKnowledgeContextParams {
  goalId: string;
  knowledgeContext?: string;
  knowledgeTransfer?: KnowledgeTransfer;
  knowledgeManager?: KnowledgeManager;
  logger?: Logger;
}

export async function buildEnrichedKnowledgeContext(
  params: BuildEnrichedKnowledgeContextParams
): Promise<string | undefined> {
  const {
    goalId,
    knowledgeContext,
    knowledgeTransfer,
    knowledgeManager,
    logger,
  } = params;

  let enrichedKnowledgeContext = knowledgeContext;

  if (knowledgeTransfer) {
    try {
      const { contextSnippets } = await knowledgeTransfer.detectCandidatesRealtime(goalId);
      if (contextSnippets.length > 0) {
        const snippetText = contextSnippets.join("\n");
        enrichedKnowledgeContext = knowledgeContext
          ? `${knowledgeContext}\n${snippetText}`
          : snippetText;
      }
    } catch (err) {
      logger?.warn(
        `[TaskLifecycle] Knowledge transfer candidate detection failed (proceeding without enrichment): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (!knowledgeManager) return enrichedKnowledgeContext;

  try {
    const pastReflections = await getReflectionsForGoal(knowledgeManager, goalId, 5, logger);
    if (pastReflections.length > 0) {
      const reflectionText = formatReflectionsForPrompt(pastReflections);
      enrichedKnowledgeContext = enrichedKnowledgeContext
        ? `${enrichedKnowledgeContext}\n${reflectionText}`
        : reflectionText;
    }
  } catch (err) {
    logger?.warn(
      `[TaskLifecycle] Failed to load past reflections (proceeding without): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return enrichedKnowledgeContext;
}
