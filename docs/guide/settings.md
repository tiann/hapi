# settings.json reference

`~/.hapi/settings.json` stores both server and CLI settings.
If `HAPI_HOME` is set, the file lives at `$HAPI_HOME/settings.json` instead.

## Behavior

- Source priority: environment variable > settings.json > default value.
- When the server reads a value from env and the key is missing, it saves it into settings.json.
- When the CLI reads values from env, it does not overwrite settings.json.
- Missing keys are normal; defaults apply.

## Keys

### Core (shared)

| Key | Type | Env var | Description |
| --- | --- | --- | --- |
| `cliApiToken` | string | `CLI_API_TOKEN` | Shared secret used by server, CLI, and web login. Base token only (no namespace suffix). Auto-generated if missing. |
| `machineId` | string | - | CLI-generated machine UUID, used to identify the machine on the server. |
| `machineIdConfirmedByServer` | boolean | - | Internal flag set after server confirms machine registration. |
| `daemonAutoStartWhenRunningHappy` | boolean | - | Internal flag for daemon auto-start preference. |

### CLI-only

| Key | Type | Env var | Default | Description |
| --- | --- | --- | --- | --- |
| `serverUrl` | string | `HAPI_SERVER_URL` | `http://localhost:3006` | Server base URL for CLI connections. |

### Server settings (persisted from env)

| Key | Type | Env var | Default | Description |
| --- | --- | --- | --- | --- |
| `telegramBotToken` | string | `TELEGRAM_BOT_TOKEN` | `null` | Telegram bot token from @BotFather. |
| `telegramNotification` | boolean | `TELEGRAM_NOTIFICATION` | `true` | Enable Telegram notifications. |
| `webappHost` | string | `WEBAPP_HOST` | `127.0.0.1` | Host/IP for the HTTP server bind. |
| `webappPort` | number | `WEBAPP_PORT` | `3006` | Port for the HTTP server. |
| `webappUrl` | string | `WEBAPP_URL` | `http://localhost:${webappPort}` | Public URL for the Mini App. |
| `corsOrigins` | string[] | `CORS_ORIGINS` | Derived from `webappUrl` | Allowed CORS origins. `*` allows all. |

### Server-generated

| Key | Type | Env var | Description |
| --- | --- | --- | --- |
| `vapidKeys.publicKey` | string | - | Web Push VAPID public key (auto-generated). |
| `vapidKeys.privateKey` | string | - | Web Push VAPID private key (auto-generated). |

## Example

```json
{
    "cliApiToken": "<base-token>",
    "serverUrl": "http://localhost:3006",
    "machineId": "<uuid>",
    "telegramBotToken": "<bot-token>",
    "telegramNotification": true,
    "webappHost": "127.0.0.1",
    "webappPort": 3006,
    "webappUrl": "http://localhost:3006",
    "corsOrigins": ["http://localhost:3006"],
    "vapidKeys": {
        "publicKey": "<vapid-public>",
        "privateKey": "<vapid-private>"
    }
}
```

Notes:
- Do not set `CLI_API_TOKEN` with a `:<namespace>` suffix in settings.json.
- If you remove a key, defaults or env vars will be used on next start.
