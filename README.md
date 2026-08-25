# EVI Station Alert ⚡

An iPhone + Scriptable monitor for the SONOL EVI charging station at **Gamla 3, Hadera**.

## Goal

- Show live connector status in an iPhone Home Screen widget.
- ON/OFF monitoring from the widget.
- While ON, check the station every 5 minutes in the cloud.
- Send an iPhone notification when a connector becomes newly available.
- Allow a manual refresh from the widget.

## Architecture

```text
Scriptable widget (iPhone)
        |
        | HTTPS
        v
Cloudflare Worker + KV
        |
        | every 5 minutes while ON
        v
SONOL EVI public Driver Portal API
        |
        +--> latest connector status stored in KV
        +--> push notification when availability appears
```

The 5-minute check runs in Cloudflare, not inside the widget, because iOS does not guarantee that a Home Screen widget will execute network code every 5 minutes.

## Repository layout

```text
scriptable/
  EVI-Station-Alert.js       Scriptable widget
  config.example.js          Local configuration template

worker/
  src/index.js               Cloudflare Worker
  package.json
  wrangler.jsonc

docs/
  INSTALL-IPHONE.md
  DEPLOY-WORKER.md
  ARCHITECTURE.md
```

## Current status

**V1 bootstrap.** The repository contains the Scriptable widget and Cloudflare Worker skeleton wired for the SONOL EVI public Driver Portal flow discovered during investigation.

## Security

Do **not** commit:

- `CONTROL_TOKEN`
- notification topic/token
- Cloudflare secrets
- personal session cookies

The repository intentionally contains placeholders only.

## Next milestone

1. Deploy the Worker.
2. Run one live status check.
3. Lock the monitor to the exact station ID for Gamla 3 / Center Park Hadera.
4. Turn on notifications.
5. Add the Scriptable widget to the Home Screen.
