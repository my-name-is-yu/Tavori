---
name: PromptGateway architecture and migration pattern
description: PromptGateway Phase D/E migration pattern, existing purposes, slot-definitions location, how to add new purposes
type: project
---

## PromptGateway — Key Files
- `src/prompt/gateway.ts` — thin orchestrator: assembles context, calls LLM, parses via responseSchema
- `src/prompt/slot-definitions.ts` — ContextPurpose union (5 existing), ContextSlot, PurposeSlotConfig
- `src/prompt/purposes/index.ts` — PURPOSE_CONFIGS map, re-exports all purpose modules
- `src/prompt/purposes/*.ts` — one file per purpose, exports SYSTEM_PROMPT constant
- `src/prompt/context-assembler.ts` — assembles XML context blocks from hierarchical memory

## Existing ContextPurpose Values (5)
`"observation" | "task_generation" | "verification" | "strategy_generation" | "goal_decomposition"`

## Migration Pattern
1. Add `gateway?: IPromptGateway` to deps interface
2. Wrap call site: `if (deps.gateway) { await deps.gateway.execute({ purpose, goalId, responseSchema, ... }) } else { /* original sendMessage fallback */ }`
3. Add new purpose to ContextPurpose union in slot-definitions.ts
4. Add PurposeSlotConfig in same file
5. Create `src/prompt/purposes/<name>.ts` with SYSTEM_PROMPT
6. Register in index.ts PURPOSE_CONFIGS

## Phase D Step 2 — Call Sites (23 confirmed across 12 files)
See `memory/scratch/phase-d-step2-research.md` for full details.

## Special Cases
- `knowledge-transfer.ts` uses `extractJSON()` + `JSON.parse()` instead of `parseJSON()` — gateway replaces this
- `ethics-gate.ts` uses custom `parseVerdictSafe()` — consider skipping or special handling
- `capability-detector.ts` has inline `VerificationResponseSchema` — hoist to module scope first
- Many call sites have no `goalId` — pass `goalId: undefined` to gateway (it's optional)

**Why:** PromptGateway centralizes hierarchical memory injection into all LLM calls.
**How to apply:** When researching or implementing LLM call migrations, check slot-definitions.ts first to see which purposes exist before proposing new ones.
