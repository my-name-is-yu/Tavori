import { ContextSlotSchema } from "../../types/session.js";
import type { ContextSlot } from "../../types/session.js";
import type { KnowledgeEntry } from "../../types/knowledge.js";
import type { VectorIndex } from "../../knowledge/vector-index.js";
import { allocateBudget, selectWithinBudget, estimateTokens } from "./context-budget.js";

export { estimateTokens };

export const DEFAULT_CONTEXT_BUDGET = 50_000;

// ─── Slot Compression ───

/**
 * Compresses a context slot to fit within maxTokens.
 * Uses head + tail strategy: keeps first 60% and last 40% of allowed chars.
 */
export function compressSlot(slot: ContextSlot, maxTokens: number): ContextSlot {
  const maxChars = maxTokens * 4;
  if (slot.content.length <= maxChars) {
    return { ...slot, token_estimate: estimateTokens(slot.content) };
  }

  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  const compressed =
    slot.content.slice(0, headChars) +
    "\n...[truncated]...\n" +
    slot.content.slice(slot.content.length - tailChars);

  return {
    ...slot,
    content: compressed,
    token_estimate: estimateTokens(compressed),
  };
}

// ─── Budget Filtering ───

/**
 * Filters context slots to fit within a token budget.
 *
 * Slots are sorted by priority (ascending = higher priority first).
 * Slots are accumulated until the budget is exceeded; any slot that
 * would push the total over budget is dropped along with all subsequent slots.
 *
 * The returned array preserves the original slot order.
 */
export function filterSlotsByBudget(slots: ContextSlot[], budget: number): ContextSlot[] {
  const sorted = [...slots].sort((a, b) => a.priority - b.priority);

  let accumulated = 0;
  const kept: ContextSlot[] = [];

  for (const slot of sorted) {
    const estimate = slot.token_estimate > 0
      ? slot.token_estimate
      : Math.ceil(slot.content.length / 4);

    if (accumulated + estimate <= budget) {
      accumulated += estimate;
      kept.push(slot);
    }
  }

  const keptSet = new Set(kept);
  return slots.filter((s) => keptSet.has(s));
}

// ─── Knowledge Context Injection ───

/**
 * Inject relevant KnowledgeEntry items into an existing set of context slots.
 *
 * Each non-superseded entry is formatted as structured text and appended as
 * a new low-priority context slot (`domain_knowledge`). Empty entry arrays
 * are a no-op — the original slots are returned unchanged.
 */
export function injectKnowledgeContext(
  slots: ContextSlot[],
  entries: KnowledgeEntry[]
): ContextSlot[] {
  const activeEntries = entries.filter((e) => e.superseded_by === null);
  if (activeEntries.length === 0) return slots;

  const content = activeEntries
    .map(
      (e) =>
        `[Knowledge] Q: ${e.question}\nA: ${e.answer} (confidence: ${e.confidence})`
    )
    .join("\n\n");

  const maxPriority = slots.reduce(
    (max, s) => (s.priority > max ? s.priority : max),
    0
  );

  const knowledgeSlot: ContextSlot = {
    priority: maxPriority + 1,
    label: "domain_knowledge",
    content,
    token_estimate: 0,
  };

  return [...slots, knowledgeSlot];
}

/**
 * Phase 2 (Progressive Disclosure): Inject knowledge context using semantic search.
 * 1. searchMetadata() — fetch id+score for up to 20 candidates (no full text)
 * 2. selectWithinBudget() — pick candidates that fit the knowledge budget
 * 3. getEntryById() — load full text only for selected candidates
 *
 * Falls back to empty if no vectorIndex available.
 */
export async function injectSemanticKnowledgeContext(
  slots: ContextSlot[],
  query: string,
  vectorIndex: VectorIndex | undefined,
  contextBudget: number = DEFAULT_CONTEXT_BUDGET
): Promise<ContextSlot[]> {
  if (!vectorIndex) return slots;

  try {
    const candidates = await vectorIndex.searchMetadata(query, 20, 0.5);
    if (candidates.length === 0) return slots;

    const allocation = allocateBudget(contextBudget);
    const knowledgeBudget = allocation.knowledge;

    const withText = candidates
      .map((c) => {
        const entry = vectorIndex.getEntryById(c.id);
        return entry ? { ...c, text: entry.text } : null;
      })
      .filter((c): c is NonNullable<typeof c> => c !== null);

    const selected = selectWithinBudget(withText, knowledgeBudget);
    if (selected.length === 0) return slots;

    const maxPriority = slots.reduce(
      (max, s) => (s.priority > max ? s.priority : max),
      0
    );

    const knowledgeSlots: ContextSlot[] = selected.map((result, i) => ({
      priority: maxPriority + 1 + i,
      label: `semantic_knowledge_${i}`,
      content: result.text,
      token_estimate: Math.ceil(result.text.length / 4),
    }));

    return [...slots, ...knowledgeSlots];
  } catch {
    return slots;  // Non-critical failure
  }
}

/**
 * Inject learning feedback into context slots.
 * Adds a single "learning_feedback" slot containing all feedback strings.
 */
export function injectLearningFeedback(slots: ContextSlot[], feedback: string[]): ContextSlot[] {
  if (feedback.length === 0) {
    return slots;
  }

  const maxPriority = slots.reduce(
    (max, s) => Math.max(max, s.priority),
    0
  );

  const feedbackSlot: ContextSlot = ContextSlotSchema.parse({
    label: "learning_feedback",
    content: feedback.join("\n---\n"),
    token_estimate: feedback.join("\n---\n").length / 4,
    priority: maxPriority + 1,
  });

  return [...slots, feedbackSlot];
}
