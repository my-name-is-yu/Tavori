import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Task } from "../../../base/types/task.js";

export interface AgentLoopContextBlock {
  id: string;
  source: string;
  content: string;
  priority: number;
}

export interface SoilPrefetchQuery {
  query: string;
  rootDir: string;
  limit: number;
}

export interface SoilPrefetchResult {
  content: string;
  soilIds?: string[];
  retrievalSource?: "index" | "manifest";
  warnings?: string[];
}

export interface TaskAgentLoopAssemblyInput {
  task: Task;
  cwd?: string;
  workspaceContext?: string;
  knowledgeContext?: string;
  soilPrefetch?: (query: SoilPrefetchQuery) => Promise<SoilPrefetchResult | null>;
  maxProjectDocChars?: number;
  trustProjectInstructions?: boolean;
}

export interface TaskAgentLoopAssembly {
  cwd: string;
  systemPrompt: string;
  userPrompt: string;
  contextBlocks: AgentLoopContextBlock[];
}

export class AgentLoopContextAssembler {
  async assembleTask(input: TaskAgentLoopAssemblyInput): Promise<TaskAgentLoopAssembly> {
    const cwd = resolve(input.cwd ?? process.cwd());
    const blocks: AgentLoopContextBlock[] = [];
    const projectDocs = await loadProjectInstructionBlocks(cwd, input.maxProjectDocChars ?? 20_000, {
      trustProjectInstructions: input.trustProjectInstructions ?? true,
    });
    blocks.push(...projectDocs);

    if (input.workspaceContext?.trim()) {
      blocks.push({
        id: "workspace-context",
        source: "workspace",
        content: input.workspaceContext,
        priority: 20,
      });
    }

    if (input.knowledgeContext?.trim()) {
      blocks.push({
        id: "knowledge-context",
        source: "knowledge",
        content: input.knowledgeContext,
        priority: 30,
      });
    }

    if (input.soilPrefetch) {
      const query = [
        input.task.work_description,
        input.task.approach,
        ...input.task.success_criteria.map((criterion) => criterion.description),
        input.workspaceContext ?? "",
        input.knowledgeContext ?? "",
      ].join("\n");
      const soil = await input.soilPrefetch({ query, rootDir: cwd, limit: 5 });
      if (soil?.content.trim()) {
        blocks.push({
          id: "soil-prefetch",
          source: `soil:${soil.retrievalSource ?? "unknown"}`,
          content: [
            soil.content,
            soil.soilIds?.length ? `Soil IDs: ${soil.soilIds.join(", ")}` : "",
            soil.warnings?.length ? `Warnings: ${soil.warnings.join("; ")}` : "",
          ].filter(Boolean).join("\n"),
          priority: 15,
        });
      }
    }

    const userPrompt = [
      `Task: ${input.task.work_description}`,
      `Approach: ${input.task.approach}`,
      `Success criteria:\n${input.task.success_criteria.map((c) => `- ${c.description}`).join("\n")}`,
      blocks.length ? `Context:\n${blocks.sort((a, b) => a.priority - b.priority).map((b) => `[${b.source}]\n${b.content}`).join("\n\n")}` : "",
      "Return final output as JSON matching the required schema.",
    ].filter(Boolean).join("\n\n");

    return {
      cwd,
      systemPrompt: [
        "You are PulSeed's task agentloop.",
        "Choose tools, inspect results, and continue until this task has a final answer.",
        "Do not decide goal completion, global priority, stall, or replan.",
        "Keep changes scoped to the task and run appropriate verification.",
      ].join("\n"),
      userPrompt,
      contextBlocks: blocks,
    };
  }
}

export async function loadProjectInstructionBlocks(
  cwd: string,
  maxChars: number,
  options: { trustProjectInstructions?: boolean } = {},
): Promise<AgentLoopContextBlock[]> {
  const root = findProjectRoot(cwd);
  const dirs: string[] = [];
  let cursor = resolve(cwd);
  while (true) {
    dirs.push(cursor);
    if (cursor === root) break;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }

  const blocks: AgentLoopContextBlock[] = [];
  let remaining = maxChars;
  const homeCandidates = [
    join(homedir(), ".pulseed", "AGENTS.md"),
    join(homedir(), ".pulseed", "AGENTS.override.md"),
  ];
  for (const filePath of homeCandidates) {
    if (!existsSync(filePath) || remaining <= 0) continue;
    const content = (await readFile(filePath, "utf-8")).slice(0, remaining);
    remaining -= content.length;
    blocks.push({
      id: `project-doc:${filePath}`,
      source: filePath,
      content,
      priority: filePath.endsWith("override.md") ? 1 : 2,
    });
  }

  if (options.trustProjectInstructions === false) {
    return blocks;
  }

  for (const dir of dirs.reverse()) {
    const candidates = [join(dir, "AGENTS.md"), join(dir, "AGENTS.override.md")];
    for (const filePath of candidates) {
      if (!existsSync(filePath) || remaining <= 0) continue;
      const content = (await readFile(filePath, "utf-8")).slice(0, remaining);
      remaining -= content.length;
      blocks.push({
        id: `project-doc:${filePath}`,
        source: filePath,
        content,
        priority: filePath.endsWith("override.md") ? 3 : 5,
      });
    }
  }
  return blocks;
}

export function findProjectRoot(cwd: string): string {
  let cursor = resolve(cwd);
  while (true) {
    if (existsSync(join(cursor, ".git"))) return cursor;
    const next = dirname(cursor);
    if (next === cursor) return resolve(cwd);
    cursor = next;
  }
}
