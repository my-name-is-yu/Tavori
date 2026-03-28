// ─── pulseed knowledge commands ───

import { StateManager } from "../../state-manager.js";
import { loadSharedEntries, loadDomainKnowledge } from "../../knowledge/knowledge-search.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";

// ─── knowledge list ───

export async function cmdKnowledgeList(stateManager: StateManager): Promise<number> {
  let entries;
  try {
    entries = await loadSharedEntries(stateManager);
  } catch (err) {
    getCliLogger().error(formatOperationError("load knowledge entries", err));
    return 1;
  }

  if (entries.length === 0) {
    console.log("No knowledge entries found. Knowledge is acquired automatically during goal execution.");
    return 0;
  }

  console.log(`Found ${entries.length} knowledge entry(ies):\n`);
  console.log("ENTRY_ID                             CONFIDENCE  TAGS");
  console.log("─".repeat(72));

  for (const entry of entries) {
    const id = entry.entry_id.slice(0, 36).padEnd(37);
    const confidence = entry.confidence.toFixed(2).padEnd(11);
    const tags = entry.tags.join(", ") || "(none)";
    console.log(`${id} ${confidence} ${tags}`);
    console.log(`  Q: ${entry.question.slice(0, 80)}${entry.question.length > 80 ? "..." : ""}`);
    console.log(`  A: ${entry.answer.slice(0, 80)}${entry.answer.length > 80 ? "..." : ""}`);
    console.log();
  }

  return 0;
}

// ─── knowledge search ───

export async function cmdKnowledgeSearch(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  const query = argv[0];
  if (!query) {
    getCliLogger().error("Error: query is required. Usage: pulseed knowledge search <query>");
    return 1;
  }

  let entries;
  try {
    entries = await loadSharedEntries(stateManager);
  } catch (err) {
    getCliLogger().error(formatOperationError("load knowledge entries for search", err));
    return 1;
  }

  if (entries.length === 0) {
    console.log("No knowledge entries found.");
    return 0;
  }

  // Simple keyword search (no VectorIndex available at CLI level)
  const lowerQuery = query.toLowerCase();
  const matched = entries.filter((entry) => {
    const text = `${entry.question} ${entry.answer} ${entry.tags.join(" ")}`.toLowerCase();
    return text.includes(lowerQuery);
  });

  if (matched.length === 0) {
    console.log(`No knowledge entries matched query: "${query}"`);
    return 0;
  }

  console.log(`Found ${matched.length} matching knowledge entry(ies) for "${query}":\n`);

  for (const entry of matched) {
    console.log(`Entry: ${entry.entry_id}`);
    console.log(`  Tags:       ${entry.tags.join(", ") || "(none)"}`);
    console.log(`  Confidence: ${entry.confidence.toFixed(2)}`);
    console.log(`  Q: ${entry.question}`);
    console.log(`  A: ${entry.answer.slice(0, 160)}${entry.answer.length > 160 ? "..." : ""}`);
    console.log();
  }

  return 0;
}

// ─── knowledge stats ───

export async function cmdKnowledgeStats(stateManager: StateManager): Promise<number> {
  let sharedEntries;
  try {
    sharedEntries = await loadSharedEntries(stateManager);
  } catch (err) {
    getCliLogger().error(formatOperationError("load shared knowledge entries for stats", err));
    return 1;
  }

  // Gather per-goal domain knowledge entries
  let goalIds: string[] = [];
  try {
    goalIds = await stateManager.listGoalIds();
  } catch {
    // No goals yet — that's fine
  }

  let totalGoalEntries = 0;
  for (const goalId of goalIds) {
    try {
      const dk = await loadDomainKnowledge(stateManager, goalId);
      totalGoalEntries += dk.entries.length;
    } catch {
      // Skip goals we can't read
    }
  }

  const tagCounts: Record<string, number> = {};
  for (const entry of sharedEntries) {
    for (const tag of entry.tags) {
      tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
  }

  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const avgConfidence =
    sharedEntries.length > 0
      ? sharedEntries.reduce((sum, e) => sum + e.confidence, 0) / sharedEntries.length
      : 0;

  console.log("Knowledge Base Statistics");
  console.log("─".repeat(40));
  console.log(`  Shared KB entries:   ${sharedEntries.length}`);
  console.log(`  Per-goal entries:    ${totalGoalEntries}`);
  console.log(`  Goals tracked:       ${goalIds.length}`);
  console.log(`  Avg confidence:      ${sharedEntries.length > 0 ? avgConfidence.toFixed(2) : "N/A"}`);

  if (topTags.length > 0) {
    console.log("\nTop tags:");
    for (const [tag, count] of topTags) {
      console.log(`  ${tag.padEnd(30)} ${count}`);
    }
  }

  return 0;
}
