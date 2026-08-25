# Deploy the Cloudflare Worker from iSH

## 1. Install Node.js in iSH

```sh
apk update
apk add nodejs npm python3
```

## 2. Clone the repository

```sh
git clone git@github.com:naor5252-star/EVI-Station-alert.git
cd EVI-Station-alert/worker
npm install
```

If SSH is not configured yet, HTTPS clone is also fine.

## 3. Sign in to Cloudflare

```sh
npx wrangler login
```

## 4. Create the KV namespace

```sh
npx wrangler kv namespace create STATE
```

Copy the returned namespace ID into `wrangler.jsonc` in place of:

```text
REPLACE_WITH_KV_NAMESPACE_ID
```

## 5. Create secrets

Generate a control token:

```sh
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
```

Save it somewhere private, then:

```sh
npx wrangler secret put CONTROL_TOKEN
```

For notifications, create a private ntfy topic name:

```sh
python3 - <<'PY'
import secrets
print("gamla-" + secrets.token_urlsafe(18))
PY
```

Then:

```sh
npx wrangler secret put NTFY_TOPIC
```

Do not commit either value.

## 6. Deploy

```sh
npm run deploy
```

Wrangler will print a URL similar to:

```text
https://evi-station-alert.<subdomain>.workers.dev
```

## 7. Test

```sh
export URL="https://YOUR-WORKER.workers.dev"
export TOKEN="YOUR_CONTROL_TOKEN"
```

Status:

```sh
curl -H "Authorization: Bearer $TOKEN" "$URL/status"
```

Enable monitoring:

```sh
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' \
  "$URL/monitor"
```

Manual refresh:

```sh
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  "$URL/refresh"
```

## 8. Lock to the exact station ID

After the first successful response reveals the exact station ID for Gamla 3, set it as a Worker secret/variable:

```sh
npx wrangler secret put GAMLA_STATION_ID
```

Paste the numeric station ID.

From then on, every 5-minute check goes directly to `findStationById` instead of scanning Hadera.
