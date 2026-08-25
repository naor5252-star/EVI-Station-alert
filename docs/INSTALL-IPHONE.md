# Install the Scriptable widget on iPhone

## 1. Install Scriptable

Install Scriptable from the App Store.

## 2. Copy the script

Open `scriptable/EVI-Station-Alert.js` from this repository and create a new Scriptable script with the same name:

```text
EVI-Station-Alert
```

Paste the file contents and save.

## 3. Configure it

Run the script once inside Scriptable.

Choose:

```text
הגדרה / שינוי שרת
```

Enter:

- Worker URL — the `workers.dev` URL from Cloudflare.
- CONTROL_TOKEN — the private token configured with Wrangler.

These values are stored in Scriptable Keychain and should not be committed to GitHub.

## 4. Add the widget

1. Long press the iPhone Home Screen.
2. Add a widget.
3. Choose **Scriptable**.
4. Choose **Medium**.
5. Edit the widget.
6. Select script: **EVI-Station-Alert**.

## Controls

### `🟢 ON / ⚫ OFF`

Tapping the status opens Scriptable and toggles cloud monitoring.

When ON, Cloudflare checks SONOL every 5 minutes.

When OFF, the scheduled Worker wakes up but skips the SONOL request.

### `↻ רענן`

Performs an immediate one-time status check.

## Important iOS behavior

The widget asks iOS to refresh after roughly five minutes while monitoring is ON, but iOS decides the actual Home Screen refresh timing.

The important part — the 5-minute SONOL check and notification — happens in Cloudflare and is therefore independent of WidgetKit/Scriptable refresh timing.
