import type { Criterion } from "../../orchestrator/execution/types/task.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext, ToolResult } from "../../tools/types.js";

/**
 * Result of a single criterion verification via tool.
 */
export interface VerificationDetail {
  criterion: Criterion;
  toolName: string;
  toolResult: ToolResult;
  passed: boolean;
}

/**
 * Outcome of Verification Layer 1 (mechanical, tool-based).
 */
export interface VerificationLayer1Result {
  /**
   * True when all blocking criteria passed (or no tool-verifiable criteria exist).
   * False when at least one blocking criterion failed.
   */
  mechanicalPassed: boolean;
  details: VerificationDetail[];
}

/** Allowed URL schemes for http_fetch verification. Only http/https are permitted. */
const ALLOWED_URL_SCHEMES = ["http://", "https://"];

/**
 * Map a criterion's verification_method string to a tool call.
 * Returns null when the method cannot be verified mechanically.
 *
 * Supported prefixes:
 *   "run <cmd>" / "execute <cmd>"     -> shell tool
 *   "check file <pat>" / "file exists <pat>"  -> glob tool
 *   "read <path>" / "verify content <path>"   -> read tool
 *   "fetch <url>" / "check endpoint <url>"    -> http_fetch tool
 */
function mapCriterionToToolCall(
  criterion: Criterion,
): { toolName: string; input: unknown; canVerify: boolean } {
  const method = criterion.verification_method;

  if (method.startsWith("run ") || method.startsWith("execute ")) {
    const command = method.replace(/^(run|execute)\s+/, "");
    // Shell verification commands from LLM-generated criteria must go through approvalFn.
    // preApproved is explicitly set to false at the call site to prevent bypassing the permission gate.
    return { toolName: "shell", input: { command }, canVerify: true };
  }

  if (method.startsWith("check file ") || method.startsWith("file exists ")) {
    const pattern = method.replace(/^(check file|file exists)\s+/, "");
    return { toolName: "glob", input: { pattern }, canVerify: true };
  }

  if (method.startsWith("read ") || method.startsWith("verify content ")) {
    const filePath = method.replace(/^(read|verify content)\s+/, "");
    return { toolName: "read", input: { file_path: filePath }, canVerify: true };
  }

  if (method.startsWith("fetch ") || method.startsWith("check endpoint ")) {
    const url = method.replace(/^(fetch|check endpoint)\s+/, "");
    // SSRF protection: only allow http:// and https:// schemes.
    // Reject file://, ftp://, data://, internal IPs, etc.
    if (!ALLOWED_URL_SCHEMES.some((scheme) => url.startsWith(scheme))) {
      return { toolName: "__skip__", input: null, canVerify: false };
    }
    return { toolName: "http_fetch", input: { url, method: "GET" }, canVerify: true };
  }

  return { toolName: "__skip__", input: null, canVerify: false };
}

/**
 * Verification Layer 1: tool-based mechanical verification.
 *
 * Maps each task success criterion to a tool call, runs them in parallel,
 * and returns whether all blocking criteria passed.
 *
 * If no criteria can be verified mechanically, returns mechanicalPassed=true
 * so the caller can proceed to Layer 2 (task reviewer).
 *
 * @param criteria   Task success criteria
 * @param toolExecutor  Executor with registered tools (shell, glob, read, http_fetch)
 * @param context       Tool call context (cwd, goalId, trust, approval)
 */
export async function verifyWithTools(
  criteria: Criterion[],
  toolExecutor: ToolExecutor,
  context: ToolCallContext,
): Promise<VerificationLayer1Result> {
  if (criteria.length === 0) {
    return { mechanicalPassed: true, details: [] };
  }

  const mappings = criteria.map((c) => ({ criterion: c, ...mapCriterionToToolCall(c) }));
  const verifiable = mappings.filter((m) => m.canVerify);

  if (verifiable.length === 0) {
    // No tool-verifiable criteria; fall through to Layer 2
    return { mechanicalPassed: true, details: [] };
  }

  // Shell verification commands come from LLM-generated criteria and must never bypass
  // the normal permission gate. Override preApproved=false so approvalFn is always called.
  const shellContext: ToolCallContext = { ...context, preApproved: false };

  // Execute all verification tool calls (read-only, parallelize safely)
  const toolResults = await Promise.all(
    verifiable.map((m) => {
      const ctx = m.toolName === "shell" ? shellContext : context;
      return toolExecutor.execute(m.toolName, m.input, ctx);
    }),
  );

  const details: VerificationDetail[] = verifiable.map((m, i) => ({
    criterion: m.criterion,
    toolName: m.toolName,
    toolResult: toolResults[i],
    passed: toolResults[i].success,
  }));

  // All blocking criteria must pass
  const blockingFailed = details.some(
    (d) => d.criterion.is_blocking && !d.passed,
  );

  return { mechanicalPassed: !blockingFailed, details };
}
