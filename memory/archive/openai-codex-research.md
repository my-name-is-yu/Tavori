# OpenAI / Codex Support — Research Report

Generated: 2026-03-15

---

## A. Current Architecture Summary

### ILLMClient (src/llm-client.ts)

Two methods to implement:

```typescript
interface ILLMClient {
  sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse>;
  parseJSON<T>(content: string, schema: ZodSchema<T>): T;
}
```

Key types:
- `LLMMessage`: `{ role: "user" | "assistant"; content: string }`
- `LLMRequestOptions`: `{ model?, max_tokens?, system?, temperature? }` — note `system` is a top-level field, not a message role
- `LLMResponse`: `{ content: string; usage: { input_tokens, output_tokens }; stop_reason: string }`

`parseJSON` is identical across all implementations — it calls `extractJSON(content)` (strips markdown fences) then Zod `.parse()`. Can be copied verbatim.

### IAdapter (src/adapter-layer.ts)

One method to implement:

```typescript
interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
}
```

- `AgentTask`: `{ prompt: string; timeout_ms: number; adapter_type: string }`
- `AgentResult`: `{ success, output, error, exit_code, elapsed_ms, stopped_reason }`

### Existing provider: OllamaLLMClient (src/ollama-client.ts)

**Confirmed** — Already implements OpenAI-compatible `/v1/chat/completions` via native `fetch`. The OpenAI LLM client is structurally identical to this; the only differences are authentication header and base URL. The `OllamaLLMClient` is the direct template to follow.

### Wiring pattern (src/cli-runner.ts)

`buildLLMClient()` reads `MOTIVA_LLM_PROVIDER` env var, returns an `ILLMClient` instance:
- `"ollama"` → `OllamaLLMClient`
- default → `LLMClient` (Anthropic)

`llmClient` is then injected into: `EthicsGate`, `StrategyManager`, `TaskLifecycle`, `GoalDependencyGraph`, `GoalTreeManager`, `GoalNegotiator`, `ClaudeAPIAdapter`.

`adapterRegistry` has two adapters registered by default:
- `ClaudeCodeCLIAdapter` (adapterType: `"claude_code_cli"`)
- `ClaudeAPIAdapter` (adapterType: `"claude_api"`) — wraps whichever `ILLMClient` was built

`src/tui/entry.ts` has its own `buildDeps()` that mirrors cli-runner but currently hardcodes `new LLMClient(apiKey)` — does NOT have the Ollama branching logic.

---

## B. OpenAI LLM Client (src/openai-client.ts)

### npm package

`openai` v6.27.0 (latest as of 2026-03-15). Install: `npm install openai`.

### API mapping

| Motiva field | OpenAI SDK equivalent |
|---|---|
| `options.system` | `{ role: "developer", content: system }` prepended to messages array (replaces old `"system"` role; `"system"` still works but `"developer"` is current convention) |
| `options.model` | `model` param |
| `options.max_tokens` | `max_tokens` param |
| `options.temperature` | `temperature` param |
| `response.content` | `completion.choices[0].message.content ?? ""` |
| `response.usage.input_tokens` | `completion.usage?.prompt_tokens ?? 0` |
| `response.usage.output_tokens` | `completion.usage?.completion_tokens ?? 0` |
| `response.stop_reason` | `completion.choices[0]?.finish_reason ?? "unknown"` |

### Constructor pattern

```typescript
import OpenAI from "openai";

export interface OpenAIClientConfig {
  apiKey?: string;   // falls back to OPENAI_API_KEY env var
  model?: string;    // default: "gpt-4o"
  baseURL?: string;  // optional: for Azure or proxy endpoints
}

export class OpenAILLMClient implements ILLMClient {
  private readonly client: OpenAI;
  private readonly model: string;
  constructor(config: OpenAIClientConfig = {}) {
    const key = config.apiKey ?? process.env["OPENAI_API_KEY"];
    if (!key) throw new Error("OpenAILLMClient: no API key. Set OPENAI_API_KEY.");
    this.client = new OpenAI({ apiKey: key, ...(config.baseURL ? { baseURL: config.baseURL } : {}) });
    this.model = config.model ?? "gpt-4o";
  }
}
```

### sendMessage implementation

Build the messages array: if `options.system` is present, prepend `{ role: "developer", content: system }`. Then call:

```typescript
const completion = await this.client.chat.completions.create({
  model,
  messages: openAiMessages,
  max_tokens,
  temperature,
});
```

Note: `openai` SDK is a runtime dependency (not Ollama's no-dep fetch approach), but the SDK handles retries and typing cleanly.

### Retry strategy

The `openai` SDK has built-in retry support (default 2 retries). For consistency with the rest of Motiva (3 retries with exponential backoff), either:
- Use `new OpenAI({ maxRetries: 3 })` and keep the manual retry loop from `LLMClient`, OR
- Rely on SDK retries and omit manual loop — simpler

The `OllamaLLMClient` uses manual retry; recommend keeping the same pattern for consistency.

### Recommended models (2026)

- `gpt-4o` — fast, capable, good default
- `gpt-4o-mini` — cheap, fast
- `o3` / `o4-mini` — reasoning models (note: may not support `temperature`)
- `gpt-5.2` — latest flagship (as of 2026)

---

## C. Codex Adapter (src/adapters/openai-codex.ts)

### Is Codex a spawnable CLI? **Confirmed — Yes**

Codex CLI (`@openai/codex`) is a terminal agent similar to `claude`. It supports a non-interactive exec mode:

```
codex exec [flags] "PROMPT"
codex e "PROMPT"                     # short alias
echo "PROMPT" | codex exec -         # stdin pipe
```

Key flags:
- `--model, -m` — override model
- `--sandbox, -s` — `read-only | workspace-write | danger-full-access`
- `--ask-for-approval, -a` — `untrusted | on-request | never`
- `--full-auto` — preset: workspace-write + on-request approvals (useful for Motiva)
- `--json` — output newline-delimited JSON events (useful for parsing)
- `--output-last-message, -o <file>` — save final response to file
- `--ephemeral` — no session persistence

### Adapter implementation

Structure mirrors `ClaudeCodeCLIAdapter` almost exactly:

```typescript
export class OpenAICodexCLIAdapter implements IAdapter {
  readonly adapterType = "openai_codex_cli";
  private readonly cliPath: string;
  private readonly extraArgs: string[];

  constructor(config: { cliPath?: string; fullAuto?: boolean } = {}) {
    this.cliPath = config.cliPath ?? "codex";
    // --full-auto = workspace-write sandbox + on-request approvals
    this.extraArgs = config.fullAuto ? ["--full-auto"] : [];
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    // spawn: codex exec --full-auto "PROMPT"
    // OR:    echo "PROMPT" | codex exec -
    const spawnArgs = ["exec", ...this.extraArgs, task.prompt];
    // rest identical to ClaudeCodeCLIAdapter
  }
}
```

Prompt delivery choice: pass as CLI argument (simpler, no stdin pipe needed). The `exec` subcommand takes the prompt as a positional argument.

**adapterType string**: `"openai_codex_cli"` — distinct from `"claude_code_cli"`.

### Alternative: OpenAI API adapter

An `OpenAIAPIAdapter` (wrapping `OpenAILLMClient`) is trivially created by registering a `ClaudeAPIAdapter`-style wrapper with `adapterType = "openai_api"`. Since `ClaudeAPIAdapter` already accepts any `ILLMClient`, you can simply do:

```typescript
// In cli-runner.ts buildDeps():
const openAiClient = new OpenAILLMClient({ model: "gpt-4o" });
adapterRegistry.register(new ClaudeAPIAdapter(openAiClient));  // reuses existing adapter
// But adapterType will be "claude_api" — may want a dedicated OpenAIAPIAdapter with adapterType "openai_api"
```

---

## D. Wiring Changes

### src/cli-runner.ts

Extend `buildLLMClient()`:

```typescript
private buildLLMClient(apiKey?: string): ILLMClient {
  const provider = process.env.MOTIVA_LLM_PROVIDER;
  if (provider === "ollama") { ... }           // existing
  if (provider === "openai") {
    const openAiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL ?? "gpt-4o";
    return new OpenAILLMClient({ apiKey: openAiKey, model });
  }
  return new LLMClient(apiKey);  // Anthropic default
}
```

Register Codex adapter in `buildDeps()`:

```typescript
adapterRegistry.register(new ClaudeCodeCLIAdapter());
adapterRegistry.register(new ClaudeAPIAdapter(llmClient));
adapterRegistry.register(new OpenAICodexCLIAdapter({ fullAuto: true }));  // new
// Optionally add an openai_api adapter too
```

Update API key validation (currently checks `ANTHROPIC_API_KEY` or `MOTIVA_LLM_PROVIDER === "ollama"`):

```typescript
const needsAnthropicKey = provider !== "ollama" && provider !== "openai";
if (!apiKey && needsAnthropicKey) { ... }
```

Update help text to document `OPENAI_API_KEY`, `OPENAI_MODEL`.

### src/tui/entry.ts

Currently hardcodes `new LLMClient(apiKey)` — does not pick up Ollama or OpenAI. TUI `buildDeps()` needs to be refactored to match CLI `buildLLMClient()` pattern, or extract a shared `buildLLMClient()` helper to a utility file (e.g., `src/provider-factory.ts`) and import it in both places.

This is the most impactful gap: tui/entry.ts is behind cli-runner.ts (missing the Ollama switch already added there).

---

## E. Dependencies

```json
{
  "dependencies": {
    "openai": "^6.27.0"
  }
}
```

No other additions needed. The `openai` SDK ships TypeScript types natively. `@openai/codex` is a CLI tool installed globally by the user — it is NOT a runtime dependency of Motiva (same pattern as `claude` CLI).

---

## F. Configuration

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `MOTIVA_LLM_PROVIDER` | Which LLM backend: `anthropic` (default), `ollama`, `openai` | `anthropic` |
| `OPENAI_API_KEY` | API key for OpenAI LLM client | required when provider=openai |
| `OPENAI_MODEL` | Model override | `gpt-4o` |
| `OPENAI_BASE_URL` | Optional proxy/Azure endpoint | — |
| `ANTHROPIC_API_KEY` | Existing Anthropic key | required when provider=anthropic |
| `OLLAMA_BASE_URL` | Existing Ollama URL | `http://localhost:11434` |
| `OLLAMA_MODEL` | Existing Ollama model | `qwen3:4b` |

### CLI flag option (optional enhancement)

Could add `--provider anthropic|openai|ollama` to the `motiva run` subcommand for one-shot overrides without env var changes.

### Goal adapter_type field

Goals store `adapter_type` (e.g., `"claude_code_cli"`, `"claude_api"`). When using OpenAI Codex, goals should specify `"openai_codex_cli"` or `"openai_api"`. This requires either:
1. Updating goal creation to accept `--adapter` flag, OR
2. Defaulting to a configured default adapter (env var `MOTIVA_DEFAULT_ADAPTER`)

---

## Gaps / Uncertainties

- **Codex exec stdin pipe**: Confirmed `-` accepts stdin, but exact behavior when prompt contains special characters as a positional argument is untested. May need shell quoting or prefer stdin pipe path for safety. **Likely** the same EPIPE handling as ClaudeCodeCLIAdapter applies.
- **Codex auth**: Requires user to have run `codex` interactively at least once to complete OAuth/API key setup. No programmatic auth path. Same constraint as `claude` CLI.
- **Responses API**: OpenAI is pushing toward the Responses API (newer, stateful, built-in tools). For Motiva's use case (single-turn LLM calls for goal decomposition / verification), Chat Completions is sufficient. No action needed unless Motiva later needs web search or code interpreter tools.
- **TUI provider switching**: tui/entry.ts already lags cli-runner.ts on Ollama support. Extracting a shared `buildLLMClient()` factory is the clean fix but requires touching both files.
- **o3/o4-mini temperature**: OpenAI reasoning models may reject `temperature` param or require `temperature=1`. The `OpenAILLMClient.sendMessage()` should conditionally omit temperature for reasoning models.

---

## Implementation Order (Recommended)

1. `src/openai-client.ts` — `OpenAILLMClient` (template: ollama-client.ts, use `openai` SDK)
2. `src/adapters/openai-codex.ts` — `OpenAICodexCLIAdapter` (template: claude-code-cli.ts)
3. `src/cli-runner.ts` — extend `buildLLMClient()`, register Codex adapter, update validation + help text
4. Extract shared `buildLLMClient()` to `src/provider-factory.ts`
5. `src/tui/entry.ts` — switch to shared factory
6. `package.json` — add `"openai": "^6.27.0"`

---

Sources:
- [openai npm package](https://www.npmjs.com/package/openai)
- [openai/openai-node GitHub](https://github.com/openai/openai-node)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Codex CLI features](https://developers.openai.com/codex/cli/features/)
- [openai/codex GitHub](https://github.com/openai/codex)
- [OpenAI Responses vs Chat Completions (Simon Willison)](https://simonwillison.net/2025/Mar/11/responses-vs-chat-completions/)
- [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses/)
