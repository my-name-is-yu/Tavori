# Security Policy

Thank you for helping keep PulSeed secure. This document describes how to report security vulnerabilities and explains PulSeed's security architecture.

## Reporting Security Vulnerabilities

If you discover a security vulnerability in PulSeed, please report it responsibly:

### Option 1: GitHub Security Advisory (Recommended)
Use GitHub's [Security Advisory](https://github.com/my-name-is-yu/PulSeed/security/advisories) feature to report vulnerabilities privately. This allows coordinated disclosure before public announcement.

### Option 2: Email
Email your report to [yuyoshimuta@gmail.com](mailto:yuyoshimuta@gmail.com) with:
- Description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if available)

**Do not** open a public GitHub issue for security vulnerabilities.

## Scope: What Counts as a Security Issue

We consider the following as security issues in PulSeed's scope:

- **Privilege escalation** — any ability to execute unauthorized actions with elevated permissions
- **Approval bypass** — circumventing PulSeed's irreversible-action approval gates
- **State tampering** — unauthorized read/write access to `~/.pulseed/` state files without proper protections
- **Plugin injection** — loading malicious code from `~/.pulseed/plugins/` via path traversal or symlink attacks
- **LLM prompt injection** — ability to override goal definitions or manipulate decision logic through crafted inputs
- **Information disclosure** — exposure of sensitive data (API keys, goal details, session logs) through logs, error messages, or state files
- **Denial of service** — infinite loops, unbounded resource consumption, or crashes via malformed input
- **Type confusion** — Zod schema bypasses leading to unsafe state mutations

## Out of Scope

The following are **not** PulSeed's responsibility:

- **LLM provider security** — vulnerabilities in OpenAI, Anthropic, or other LLM APIs
- **User API key management** — how you store, rotate, or protect your own `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variables
- **Third-party adapter security** — vulnerabilities in external agents (Claude Code CLI, OpenAI Codex, Browser Use, etc.)
- **Operating system sandbox** — OS-level file permissions and process isolation
- **User machine compromise** — if an attacker has full access to your machine, no local-state application can defend against it

## Security Design Overview

PulSeed implements multiple layers of protection:

### 1. EthicsGate (2-Stage Approval)
Every goal and task passes through a 2-stage ethics check before execution:
- **Stage 1 (mechanical)**: Detects blacklisted keywords, resource limits, and unsafe operations
- **Stage 2 (LLM)**: Sends suspicious requests to the LLM for contextual judgment

See `src/ethics-gate.ts` for implementation details.

### 2. Asymmetric Trust Model
PulSeed uses a failure-penalizing trust system (range `[-100, +100]`):
- Success reward: +3
- Failure penalty: −10
- Irreversible actions (code execution, state mutation) always require human approval regardless of trust score

This asymmetry prevents over-reliance on agent track records after a few successful runs.

### 3. Approval Gates for Irreversible Actions
Any action that cannot be undone requires explicit user approval:
- Code generation and execution
- State mutations
- Plugin loads
- External system modifications

PulSeed never executes these directly; it delegates to agents and verifies results.

### 4. Local State Isolation
- State stored in user's home directory: `~/.pulseed/` (user-owned, not world-readable by default)
- No network exposure of state files (unless you explicitly configure event listeners)
- State includes confidence scores to distinguish high-evidence observations from self-reports

### 5. Plugin Sandboxing (Minimal)
- Plugins load from `~/.pulseed/plugins/` only
- Each plugin is require()'d as-is; no source code verification
- Recommendation: **review plugin source code before installation**; use version pinning in your plugin manifest

## Vulnerability Response Timeline

We aim to:
1. Acknowledge receipt within 48 hours
2. Provide an initial assessment within 1 week
3. Release a patch within 2 weeks (or earlier for critical issues)
4. Credit the reporter (unless you prefer anonymity)

## Security Best Practices for PulSeed Users

1. **Rotate API keys regularly** — treat `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` like credentials
2. **Review goals before execution** — use `pulseed goal list` and `pulseed status` before running the core loop
3. **Audit plugin sources** — inspect `~/.pulseed/plugins/` contents before trusting them
4. **Run PulSeed in restricted environments** — use containers or VMs if you're automating high-risk tasks
5. **Monitor state changes** — check `~/.pulseed/` periodically for unexpected modifications
6. **Use version pinning** — in `package.json`, pin PulSeed to a specific version or narrow semver range

## Contact

- **GitHub**: [my-name-is-yu/PulSeed](https://github.com/my-name-is-yu/PulSeed)
- **Email**: [yuyoshimuta@gmail.com](mailto:yuyoshimuta@gmail.com)
