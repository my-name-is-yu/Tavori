# slack-notifier

A PulSeed notifier plugin that sends events to a Slack channel via Incoming Webhook.

## Requirements

- Node.js 20+ (uses built-in `fetch`)
- A Slack Incoming Webhook URL

## Installation

Copy (or symlink) this directory into `~/.pulseed/plugins/slack-notifier/` and build it:

```bash
npm install
npm run build
```

Then create `~/.pulseed/plugins/slack-notifier/config.json`:

```json
{
  "webhook_url": "https://hooks.slack.com/services/T.../B.../...",
  "channel": "#pulseed-alerts",
  "mention_on_critical": true
}
```

## Configuration

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `webhook_url` | string | yes | — | Slack Incoming Webhook URL |
| `channel` | string | no | (webhook default) | Override the destination channel |
| `mention_on_critical` | boolean | no | `true` | Add `@channel` mention on critical-severity events |

## Supported Events

| Event | Severity example | Description |
|-------|-----------------|-------------|
| `goal_complete` | info | A goal reached its satisficing threshold |
| `approval_needed` | warning/critical | Human approval is required before proceeding |
| `stall_detected` | warning | The core loop has stalled with no progress |
| `task_blocked` | warning/critical | A task could not be executed |

Events of type `goal_progress` and `trust_change` are not forwarded by this plugin.

## Environment Variables (alternative to config.json)

| Variable | Description |
|----------|-------------|
| `SLACK_WEBHOOK_URL` | Webhook URL |
| `SLACK_CHANNEL` | Destination channel override |
| `SLACK_MENTION_ON_CRITICAL` | Set to `"false"` to disable `@channel` mentions |

## Message Format

Each notification is sent as a Slack Block Kit message:

- A colored circle emoji indicating severity (`green` info / `yellow` warning / `red` critical)
- Bold one-line summary from `event.summary`
- Context line with `goal_id`, event type, and ISO timestamp
- `@channel` mention prepended for critical events when `mention_on_critical` is enabled
