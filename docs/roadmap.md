# Roadmap

SeedPulse has completed its core implementation through 18 milestones. This document outlines future directions.

For completed milestone history, see [archive/completed-milestones.md](archive/completed-milestones.md).

---

## Future Considerations

The following areas are candidates for future investment. None are scheduled; priorities will be set as the user base and production usage patterns become clearer.

### Multi-User Support

Goal and state isolation per user, with authentication. The current design assumes a single user operating the system locally. Supporting multiple users requires scoping all persistent state (`~/.pulseed/`) per identity and adding an auth layer to the HTTP/Web UI surface. Tackle when user base grows.

### DimensionMapping Semantic Auto-Suggestion

Automatically generate Zod schemas from natural-language observation dimension names. Today, users define dimensions explicitly. An LLM-assisted mapping layer could infer schema structure from freeform goal descriptions, lowering the barrier to onboarding new goals.

### Plugin Marketplace / Registry

A discoverable registry of community plugins (data sources, notifiers, adapters). The plugin architecture (M12) and npm scope `@pulseed-plugins/` are already established. A registry UI or CLI command (`pulseed plugin search`) would make the ecosystem navigable.

### Circuit Breaker

Automatic disconnection when an adapter fails repeatedly. Currently, a failing adapter degrades observation quality silently over multiple loops. A circuit breaker pattern — open after N consecutive failures, half-open after a cooldown — would prevent noisy failed adapters from polluting state.

### Backpressure Control

Maximum parallel agent count management. When many goals are active simultaneously and all drive scores are high, PulSeed can spawn more concurrent sessions than the underlying infrastructure can handle. A configurable concurrency cap with queue-based backpressure would stabilize behavior under load.

### Streaming Observation

Real-time streaming data source support (WebSocket, SSE, Kafka). The current DataSourceAdapter is pull-based. Push-based streaming sources would allow sub-second gap detection for time-sensitive goals without polling overhead.

### Goal Templates

Reusable goal blueprints for common use cases (e.g., "maintain a healthy codebase," "track a business KPI"). Templates would encode recommended dimension structures, threshold defaults, and strategy hints, letting users bootstrap well-formed goals without starting from scratch.
