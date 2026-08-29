# Notifications

Get notified when sessions need input, request permissions, fail, or complete — via Telegram, Server酱 (ServerChan), Web Push, or voice. WxPusher App can optionally deliver session completion notifications.

Web Push works out of the box once you [install the PWA](./pwa.md); no configuration needed. The channels below are optional.

## Telegram Setup

Enable Telegram notifications and Mini App access:

1. Message [@BotFather](https://t.me/BotFather) and create a bot
2. Set the bot token and public URL
3. Start the hub and bind your account

```bash
export TELEGRAM_BOT_TOKEN="your-bot-token"
export HAPI_PUBLIC_URL="https://your-public-url"

hapi hub
```

Then message your bot with `/start`, open the app, and enter your `CLI_API_TOKEN`.

Related environment variables:

- `TELEGRAM_NOTIFICATION` - Enable/disable Telegram notifications (default: `true`)

**Troubleshooting:**

- If binding fails, verify `HAPI_PUBLIC_URL` is accessible from the internet
- Telegram Mini App requires HTTPS (not HTTP)

## ServerChan (Server酱) Setup

Server酱 pushes notifications to WeChat and other channels. The hub sends ServerChan messages when a session is ready for input, requests a permission, a task fails, or a session completes.

1. Get a SendKey from [sct.ftqq.com](https://sct.ftqq.com/)
2. Set the SendKey and start the hub:

```bash
export SERVERCHAN_SENDKEY="your-sendkey"
export HAPI_PUBLIC_URL="https://your-public-url"

hapi hub
```

Messages include a link back to the session, built from `HAPI_PUBLIC_URL`.

Related environment variables:

- `SERVERCHAN_NOTIFICATION` - Enable/disable ServerChan notifications (default: `true`)
- `SERVERCHAN_BACKGROUND_ONLY` - Only send ServerChan notifications when the namespace has no visible HAPI connection (default: `false`)

When `SERVERCHAN_BACKGROUND_ONLY=true`, a visible HAPI connection suppresses ServerChan for the entire namespace. Hidden, disconnected, or closed HAPI pages do not count as visible, so ServerChan can act as a background fallback. This is namespace-wide and does not select a particular device.

These values can also be set in `settings.json` (`serverChanSendKey`, `serverChanNotification`, `serverChanBackgroundOnly`).

## WxPusher App Setup

WxPusher sends notifications to its own Android, iOS, and desktop clients. This integration targets the standard WxPusher App/client delivery path, not the separate WeChat ClawBot channel.

1. Create a WxPusher application and copy its `appToken`
2. Install a WxPusher client, subscribe to the application, and copy your UID
3. Set the token and recipient before starting the hub:

```bash
export WXPUSHER_APP_TOKEN="AT_your-app-token"
export WXPUSHER_UIDS="UID_your-uid"
export HAPI_PUBLIC_URL="https://your-public-url"

hapi hub
```

Multiple UIDs can be separated by commas. Topic recipients can be configured with `WXPUSHER_TOPIC_IDS` instead:

```bash
export WXPUSHER_TOPIC_IDS="123,456"
```

The current WxPusher channel sends session completion notifications only. It remains disabled unless an app token and at least one UID or topic ID are configured.

Related environment variables:

- `WXPUSHER_APP_TOKEN` - WxPusher application token
- `WXPUSHER_UIDS` - Comma-separated recipient UIDs
- `WXPUSHER_TOPIC_IDS` - Comma-separated topic IDs
- `WXPUSHER_NOTIFICATION` - Enable/disable WxPusher notifications (default: `true`)
- `WXPUSHER_BACKGROUND_ONLY` - Only send WxPusher notifications when the namespace has no visible HAPI connection (default: `false`)

When `WXPUSHER_BACKGROUND_ONLY=true`, a visible HAPI connection suppresses WxPusher for the entire namespace. Hidden, disconnected, or closed HAPI pages do not count as visible, so WxPusher can act as a background fallback. This is namespace-wide and does not select a particular device.

These values can also be set in `settings.json` (`wxPusherAppToken`, `wxPusherUids`, `wxPusherTopicIds`, `wxPusherNotification`, `wxPusherBackgroundOnly`).

## Voice assistant setup

Enable voice control:

1. Get an API key from [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys)
2. Set the environment variable:

```bash
export ELEVENLABS_API_KEY="your-api-key"
hapi hub --relay
```

See [Voice Assistant](./voice-assistant.md) for usage details.
