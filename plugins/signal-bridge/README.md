# Signal Bridge Plugin

Signal integration for PulSeed using a `signal-cli` REST bridge.

This plugin polls the bridge for inbound messages and sends outbound replies
through the same bridge. That keeps the integration dependency-free while still
matching the real deployment boundary for Signal.

## Requirements

- A running `signal-cli` REST bridge
- A registered Signal account for the bridge

## Configuration

```json
{
  "bridge_url": "http://127.0.0.1:7583",
  "account": "+15551234567",
  "recipient_id": "+15557654321",
  "identity_key": "signal:ops",
  "runtime_control_allowed_sender_ids": ["+15557654321"],
  "poll_interval_ms": 5000,
  "receive_timeout_ms": 2000
}
```

## Notes

- The bridge API can vary slightly by deployment. The client uses a small set
  of compatible receive endpoints and falls back between them.
- `runtime_control_allowed_sender_ids` limits who can approve explicit PulSeed
  runtime-control requests from Signal. Leave it empty to disable those
  operations from Signal.
- Voice memo transcription is not implemented.
