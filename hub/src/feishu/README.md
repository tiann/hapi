# Feishu Integration for HAPI

## Overview

HAPI now supports Feishu (Lark) as a notification and interaction channel, using WebSocket long connection for bidirectional communication.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Internal Network Host                       │
│                                                                  │
│   ┌──────────────┐        ┌──────────────┐      ┌────────────┐  │
│   │   HAPI CLI   │◄───────│   HAPI Hub   │◄────►│ Feishu Bot │  │
│   │              │        │              │      │ (WS Client)│  │
│   └──────────────┘        └──────────────┘      └─────┬──────┘  │
│                                                        │         │
└────────────────────────────────────────────────────────┼─────────┘
                                                         │
                                               wss://open.feishu.cn
                                                         │
                                               ┌─────────▼─────────┐
                                               │   Feishu Server   │
                                               └───────────────────┘
```

## Configuration

### 0. Security Warning

**NEVER commit your actual credentials to git!**

Your Feishu credentials (`APP_ID`, `APP_SECRET`) are sensitive information. Always:
- Use environment variables or `settings.json` (already in `.gitignore`)
- Never hardcode credentials in source code
- Never commit `.env` files with real values

### 1. Create Feishu App

1. Go to [Feishu Open Platform](https://open.feishu.cn/)
2. Create a new Enterprise Internal App
3. Enable the following capabilities:
   - **Robot**: Enable bot capability
   - **Event Subscription**: Enable WebSocket long connection mode
4. Subscribe to these events:
   - `im.message.receive_v1` - Receive user messages
   - `card.action.trigger` - Handle card button clicks
   - `im.bot.added_v1` - Bot added to chat
   - `im.bot.deleted_v1` - Bot removed from chat

### 2. Get Credentials

From your Feishu app, get:
- **App ID** (e.g., `cli_xxxxxxxx`)
- **App Secret**
- **Encrypt Key** (optional, for message encryption)
- **Verification Token** (optional, for webhook verification)

### 3. Configure HAPI

Set environment variables or add to `settings.json`:

```bash
# Required
export FEISHU_APP_ID="cli_xxxxxxxx"
export FEISHU_APP_SECRET="your-secret"

# Optional
export FEISHU_ENCRYPT_KEY="your-encrypt-key"
export FEISHU_VERIFICATION_TOKEN="your-verification-token"
export FEISHU_ENABLED="true"              # Default: true if credentials present
export FEISHU_NOTIFICATION="true"         # Default: true
```

Or in `~/.hapi/settings.json`:

```json
{
  "feishuAppId": "cli_xxxxxxxx",
  "feishuAppSecret": "your-secret",
  "feishuEncryptKey": "your-encrypt-key",
  "feishuVerificationToken": "your-verification-token",
  "feishuEnabled": true,
  "feishuNotification": true
}
```

### 4. Start HAPI Hub

```bash
cd hub
bun run start
```

You should see:
```
[Hub] Feishu: enabled (environment)
[Hub] Feishu notifications: enabled (environment)
...
[FeishuBot] WebSocket connected
```

## Usage

### Binding Your Account

In Feishu, send a private message to the bot:

```
/bind <your-cli-api-token>
```

The token is your `CLI_API_TOKEN` from HAPI Hub startup logs.

### Available Commands

| Command | Description |
|---------|-------------|
| `/bind <token>` | Bind Feishu account to HAPI namespace |
| `/sessions` or `/list` | List active sessions |
| `/send <session-id> <message>` | Send message to a specific session |
| `/help` | Show help message |
| Direct message | Send to the most recent active session |

### Receiving Notifications

Once bound, you will receive:

1. **Ready Notifications**: When an agent is waiting for input
2. **Permission Requests**: When agent needs approval for tools
   - Click "Allow" or "Deny" buttons on the card
3. **Session Updates**: Via interactive cards

### Example Flow

```
User: /bind my-token-123
Bot: ✅ Bound to namespace: default

User: /sessions
Bot: [Card] Active Sessions (shows list with buttons)

User: hello agent
Bot: Message sent to session abc123...

[Later, when agent needs permission]
Bot: [Card] Permission Request - Claude
      Tool: Bash
      Command: ls -la
      [Allow] [Deny]

User: (clicks Allow)
Bot: [Card] ✅ Approved
```

## Security

- All communication uses TLS (wss:// and https://)
- Messages can be encrypted with `FEISHU_ENCRYPT_KEY`
- User binding requires valid CLI API token
- Session access is restricted to bound namespace

## Troubleshooting

### WebSocket Connection Failed

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are correct
2. App is published (not in development mode)
3. Network allows outbound connection to `open.feishu.cn:443`

### Not Receiving Notifications

Check:
1. User is bound (`/bind` command)
2. `FEISHU_NOTIFICATION` is enabled
3. Sessions are in the same namespace as bound user

### Message Send Failed

Check:
1. Session is active
2. User has permission for the namespace
3. Session ID is correct (can use first 8 chars)

## File Structure

```
hub/src/feishu/
├── index.ts         # Public exports
├── bot.ts           # FeishuBot main class
├── wsClient.ts      # WebSocket long connection client
├── apiClient.ts     # Feishu API wrapper
└── cardBuilder.ts   # Interactive card templates
```

## References

- [Feishu Open Platform](https://open.feishu.cn/)
- [Event Subscription - WebSocket Mode](https://open.feishu.cn/document/server-side/event-subscription/event-subscription-configure)
- [Interactive Card Kit](https://open.feishu.cn/document/server-side/card-kit/interactive-card)
