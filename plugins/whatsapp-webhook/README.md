# WhatsApp Webhook Plugin

WhatsApp Cloud API webhook integration for PulSeed.

Inbound messages arrive through the Meta webhook and are handed to the shared
cross-platform session manager with the configured `identity_key`. Outbound
notifications are delivered through the same Cloud API client.

## Requirements

- A WhatsApp Business account connected to the Cloud API
- A verified webhook endpoint
- A phone number id and access token

## Configuration

```json
{
  "phone_number_id": "1234567890",
  "access_token": "EAAG...",
  "verify_token": "shared-secret",
  "recipient_id": "15551234567",
  "identity_key": "whatsapp:family",
  "host": "127.0.0.1",
  "port": 8788,
  "path": "/webhook"
}
```

## Notes

- `app_secret` is optional. When present, the webhook verifies
  `X-Hub-Signature-256` before accepting POST requests.
- Voice memo transcription is not implemented.
