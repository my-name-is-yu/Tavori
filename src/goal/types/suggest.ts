import { z } from "zod";

export const SuggestionRepoContextSchema = z.object({
  path: z.string().trim().min(1),
});

export const SuggestionSchema = z.object({
  title: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  steps: z.array(z.string().trim().min(1)).min(1),
  success_criteria: z.array(z.string().trim().min(1)).min(1),
  repo_context: SuggestionRepoContextSchema.optional(),
});

export const SuggestOutputSchema = z.object({
  suggestions: z.array(SuggestionSchema).min(1),
});

export type SuggestionRepoContext = z.infer<typeof SuggestionRepoContextSchema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestOutput = z.infer<typeof SuggestOutputSchema>;
