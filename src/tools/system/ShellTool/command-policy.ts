import type { ExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";

export interface ShellCommandAssessment {
  status: "allowed" | "needs_approval" | "denied";
  reason?: string;
  capabilities: {
    readOnly: boolean;
    localWrite: boolean;
    network: boolean;
    destructive: boolean;
    protectedTarget: boolean;
  };
}

const SAFE_PATTERNS = [
  /^(cat|head|tail|wc|ls|pwd|echo|date|hostname|which|type|file)\b/,
  /^git\s+(status|log|diff|show|branch|rev-parse|rev-list|describe|tag\s+-l)\b/,
  /^npm\s+(ls|list|view|info|outdated|audit)\b/,
  /^npx\s+vitest\s+(run|list|--reporter)\b/,
  /^npx\s+tsc\s+--noemit\b/i,
  /^rg\b/, /^find\b/, /^du\b/, /^df\b/, /^tree\b/,
];

const LOCAL_WRITE_PATTERNS = [
  /\brm\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/, /\bchmod\b/, /\bchown\b/,
  /\bsed\s+-i\b/, /\bperl\s+-i\b/, /\btee\b/, />/, /\bapply_patch\b/,
  /\bgit\s+(apply|checkout|restore)\b/,
  /\bnpm\s+(install|uninstall|run|exec)\b/,
];

const NETWORK_PATTERNS = [
  /\bcurl\b/, /\bwget\b/, /\bssh\b/, /\bscp\b/, /\brsync\b/, /\bpip\s+install\b/,
  /\bnpm\s+(install|publish)\b/, /\bgit\s+(fetch|pull|push|clone)\b/,
];

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/, /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/,
  /\bgit\s+(push|commit|merge|rebase|reset|clean|stash)\b/,
  /\bsudo\b/,
];

const BLOCKED_PATTERNS = [
  /\brm\b/, /\bmv\b/, /\bcp\b/, /\bmkdir\b/, /\btouch\b/, /\bchmod\b/, /\bchown\b/,
  /\bgit\s+(push|commit|merge|rebase|reset|checkout|clean|stash)\b/,
  /\bnpm\s+(install|uninstall|publish|run|exec)\b/,
  /\bcurl\b/, /\bwget\b/, /\bsudo\b/, /\bmkfs\b/, /\bdd\s+if=/, /\bshutdown\b/, /\breboot\b/,
];

const INJECTION_PATTERNS = [/>/, /\$\(/, /`/, /\|.*(tee|dd|rm|mv)\b/];
const PROTECTED_TARGET_PATTERNS = [
  /\.git\b/i,
  /\.codex\b/i,
  /\.agents\b/i,
  /\.pulseed\b/i,
  /\bagents\.md\b/i,
  /\.env(\.[a-z0-9_-]+)?\b/i,
  /\bnode_modules\b/i,
  /\bpackage\.json\b/i,
  /\btsconfig(\.[^/\s]+)?\.json\b/i,
];

export function assessShellCommand(
  command: string,
  policy?: ExecutionPolicy,
  trusted = false,
): ShellCommandAssessment {
  const trimmed = command.trim();
  const segments = trimmed.split(/\s*(?:&&|\|\||;)\s*/).map((segment) => segment.trim()).filter(Boolean);
  const capabilities = {
    readOnly: true,
    localWrite: false,
    network: false,
    destructive: false,
    protectedTarget: false,
  };

  for (const segment of segments) {
    if (INJECTION_PATTERNS.some((pattern) => pattern.test(segment))) {
      return {
        status: "denied",
        reason: `Denied command segment (injection risk): ${segment}`,
        capabilities,
      };
    }

    const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(segment));
    const writes = LOCAL_WRITE_PATTERNS.some((pattern) => pattern.test(segment));
    const network = NETWORK_PATTERNS.some((pattern) => pattern.test(segment));
    const destructive = DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(segment));
    const protectedTarget = PROTECTED_TARGET_PATTERNS.some((pattern) => pattern.test(segment));

    if (!isSafe) capabilities.readOnly = false;
    if (writes) capabilities.localWrite = true;
    if (network) capabilities.network = true;
    if (destructive) capabilities.destructive = true;
    if (protectedTarget) capabilities.protectedTarget = true;
  }

  if (trusted && !capabilities.protectedTarget) {
    return { status: "allowed", capabilities };
  }

  if (segments.some((segment) => INJECTION_PATTERNS.some((pattern) => pattern.test(segment)))) {
    return {
      status: "denied",
      reason: `Denied command segment (injection risk): ${segments.find((segment) => INJECTION_PATTERNS.some((pattern) => pattern.test(segment)))}`,
      capabilities,
    };
  }
  if (segments.some((segment) => BLOCKED_PATTERNS.some((pattern) => pattern.test(segment)))) {
    return { status: "denied", reason: `Denied command segment: ${segments.find((segment) => BLOCKED_PATTERNS.some((pattern) => pattern.test(segment)))}`, capabilities };
  }
  if (capabilities.destructive) {
    return { status: "denied", reason: "Denied command segment: destructive shell command", capabilities };
  }
  if (capabilities.protectedTarget && capabilities.localWrite) {
    return { status: "denied", reason: "Shell command targets a protected path", capabilities };
  }
  if (capabilities.network && policy && !policy.networkAccess) {
    return { status: "denied", reason: "Network access is disabled for this session", capabilities };
  }
  if (!capabilities.localWrite && !capabilities.network && capabilities.readOnly) {
    return { status: "allowed", capabilities };
  }

  if (policy?.sandboxMode === "read_only") {
    return { status: "denied", reason: "Read-only sandbox blocks mutating shell commands", capabilities };
  }

  if (!policy) {
    return {
      status: capabilities.localWrite || capabilities.network || !capabilities.readOnly ? "needs_approval" : "allowed",
      reason: capabilities.localWrite || capabilities.network || !capabilities.readOnly ? "Unknown command segment requires approval" : undefined,
      capabilities,
    };
  }

  const needsApproval = policy.approvalPolicy !== "never";
  if (capabilities.localWrite || capabilities.network) {
    return {
      status: needsApproval ? "needs_approval" : "allowed",
      reason: needsApproval ? "Shell command requires approval under current execution policy" : undefined,
      capabilities,
    };
  }

  return { status: "allowed", capabilities };
}
