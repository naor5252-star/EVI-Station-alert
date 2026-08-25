# Architecture

## Components

### 1. Scriptable widget

Responsibilities:

- display latest state
- display connector statuses
- ON/OFF control
- manual refresh
- store Worker URL and CONTROL_TOKEN locally in Scriptable Keychain

It does **not** perform reliable 5-minute background monitoring.

### 2. Cloudflare Worker

Responsibilities:

- store monitor state in KV
- scheduled execution every 5 minutes
- call the SONOL EVI public Driver Portal API
- normalize connector status
- detect newly available connectors
- send a push notification

### 3. SONOL EVI public Driver Portal

The current implementation uses the public web flow:

```text
GET /findCharger
  -> JSESSIONID
  -> CSRF token

POST /stationFacade/findStationsInBounds
GET  /stationFacade/findStationById
```

The station detail response includes `stationSockets`, and connector status is read from fields such as `socketStatusId`, with special handling for `reserved`, `blocked`, and `inMaintenance`.

## Availability normalization

The monitor treats:

```text
AVAILABLE       -> available
CHARGING        -> occupied
OCCUPIED        -> occupied
RESERVED        -> not available
UNAVAILABLE     -> not available
FAULTED         -> not available
IN_MAINTENANCE  -> not available
UNKNOWN         -> not available
```

A socket marked as reserved, blocked, or in maintenance is never considered available even if another raw status field is misleading.

## Notification behavior

The Worker stores the previous set of available socket keys.

A push is sent only when a connector newly enters the available set, preventing repeated notifications every five minutes while the same connector stays free.

## Planned optimization

V1 can discover the target station by scanning a Hadera bounding box and scoring station metadata for:

- גמלא 3
- Gamla 3
- סנטר פארק
- Center Park
- חדרה / Hadera

Once the exact station ID is confirmed, set `GAMLA_STATION_ID` so each scheduled check becomes a direct `findStationById` request.
