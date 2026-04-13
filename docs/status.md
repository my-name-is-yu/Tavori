# Status

Current public status as of 2026-04-12.

This page stays intentionally short.
For the conceptual model, see [Mechanism](mechanism.md).
For runtime surfaces, see [Runtime](runtime.md).
For broader navigation, see [Architecture Map](architecture-map.md).

## In active use

- long-lived `CoreLoop` control
- bounded `AgentLoop` execution
- shared tool substrate
- Soil as a long-lived memory surface
- CLI, chat, TUI, daemon, and cron runtime surfaces

## Publicly supported direction

- use `pulseed` as the main entry point
- perform the normal workflow in natural language
- keep lower-level subcommands for scripting, diagnostics, and compatibility

## Still evolving

- scheduler heuristics
- provider defaults
- native AgentLoop quality and policy
- design notes under `docs/design/`

## Safety Boundary

PulSeed has software-level approval and verification gates, but it does not provide
OS-level sandboxing for delegated agent subprocesses. For high-risk or untrusted
goals, use an external container or VM boundary. See [Security](../SECURITY.md).

## Source of truth

When public docs disagree, prefer the more specific page:

1. [README](../README.md)
2. [docs/index.md](index.md)
3. [Getting Started](getting-started.md)
4. [Mechanism](mechanism.md)
5. [Runtime](runtime.md)
6. [Architecture Map](architecture-map.md)
