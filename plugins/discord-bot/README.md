# Discord Bot Plugin

Discord interaction webhook integration for PulSeed.

Inbound chat arrives through the Discord Interactions endpoint. Outbound
messages use the Discord REST API so the plugin can send normal channel
messages as well as reply to slash-command traffic.

## Requirements

- A Discord application with interactions enabled
- A slash command named `pulseed` or a custom `command_name`
- A bot token with permission to post in the configured channel
- A public key for interaction verification

## Configuration

Create `config.json` in the plugin directory:

```json
{
  "application_id": "123456789012345678",
  "public_key_hex": "deadbeef...",
  "bot_token": "Bot ...",
  "channel_id": "123456789012345678",
  "identity_key": "discord:team-a",
  "command_name": "pulseed",
  "host": "127.0.0.1",
  "port": 8787
}
```

## Notes

- The shared cross-platform session manager receives `identity_key` inside the
  inbound payload so the same conversation can continue across channels.
- If `public_key_hex` is omitted, the webhook still works for local testing but
  request verification is skipped.
- Voice memo transcription is not implemented.
