<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

Goal-driven orchestration for long-running work.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue)](https://pulseed.dev)
[![CI](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml/badge.svg)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pulseed.svg)](https://www.npmjs.com/package/pulseed)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

PulSeed is an AI agent orchestrator for goals that need more than one chat turn.

Naming note: `PulSeed` is the product name, and `pulseed` is the CLI and npm package name.

## Quick Start

1. Install Node.js 20 or newer.
2. Install the CLI:

```bash
npm install -g pulseed
```

3. Start PulSeed:

```bash
pulseed
```

Then describe what you want in natural language, such as "Increase test coverage to 90%."

## Current Architecture

PulSeed uses two layers:

- `CoreLoop` keeps a goal moving, checks progress, and decides whether to continue, refine, verify, or stop
- `AgentLoop` handles bounded tool-using work such as task execution, chat turns, and selected runtime phases

State, reports, schedules, and local memory live under `~/.pulseed/`.

Security boundary: PulSeed uses approval gates and verification around delegated work.
Supported CLI adapters can be wrapped with a configured terminal backend such as Docker,
but high-risk or untrusted goals should still run inside an environment you control. See [Security](SECURITY.md).

## Main Command

```bash
pulseed
```

PulSeed is designed so the primary workflow can happen through natural language.
Use the lower-level CLI commands only when you need scriptable or diagnostic control.

## Docs

- [Getting Started](docs/getting-started.md)
- [Docs Index](docs/index.md)
- [Mechanism](docs/mechanism.md)
- [Runtime](docs/runtime.md)
- [Configuration](docs/configuration.md)
- [Architecture Map](docs/architecture-map.md)

## Release

Run releases from a clean, up-to-date `main` branch:

```bash
npm run release -- 0.4.9
```

The script updates the package version, runs docs/build/test checks, pushes `main`,
then pushes the matching `v*` tag. The tag push triggers GitHub Actions to publish
to npm through Trusted Publishing.

## License

MIT
