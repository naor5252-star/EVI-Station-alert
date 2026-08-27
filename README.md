# EVI Station Alert ⚡

An iPhone + Scriptable monitor for two independent charging contexts:

- 🏠 **Home — SONOL EVI, Gamla 3 / Center Park Hadera**
- 🏢 **Work — EV Edge / KLA, Orbotech Buildings 3 + 7, Yavne**

## Monitoring

| Monitor | Source | Targets | Cloud interval |
| --- | --- | --- | --- |
| Home | SONOL EVI | Stations `2733`, `2790` | ~30 seconds |
| Work | EV Edge | Locations `724`, `725` | 60 seconds |

The two monitors have **separate ON/OFF state and separate buttons** in the Scriptable widget.

Telegram notifications are sent only when aggregate availability flips between:

- no free connector
- at least one free connector

Turning a monitor ON also sends its current availability immediately.

## Architecture

```text
Scriptable widget (iPhone)
        |
        | HTTPS
        v
Cloudflare Worker + KV
        |
        +--> SONOL public Driver Portal API  (~30 sec, when Home monitor is ON)
        |
        +--> EV Edge driver-app API          (60 sec, when Work monitor is ON)
        |
        +--> Telegram notifications
```

## Cloudflare configuration

Existing secrets:

- `CONTROL_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

EV Edge additionally requires:

- `EVEDGE_TOKEN` — current EV Edge driver-app bearer token
- `EVEDGE_DEVICE_ID` — the matching `x-device-id`

Optional:

- `GAMLA_STATION_IDS=2733,2790`
- `EVEDGE_LOCATION_IDS=724,725`

**Never commit tokens or device/session values to Git.**

If the EV Edge app rotates its session, update `EVEDGE_TOKEN` (and, if needed, `EVEDGE_DEVICE_ID`) in Cloudflare.

## Worker routes

Backward-compatible SONOL routes remain available:

- `GET /status`
- `POST /monitor`
- `POST /refresh`

Explicit routes:

- `GET /sonol/status`
- `POST /sonol/monitor`
- `POST /sonol/refresh`
- `GET /evedge/status`
- `POST /evedge/monitor`
- `POST /evedge/refresh`
- `GET /status/all`

All control/status routes require:

```text
Authorization: Bearer CONTROL_TOKEN
```

## Security

Do **not** commit:

- `CONTROL_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `EVEDGE_TOKEN`
- `EVEDGE_DEVICE_ID`
- personal cookies or session captures
