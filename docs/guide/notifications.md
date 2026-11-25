---
description: "Get notified when HAPI sessions need input, request permission, fail or complete, via native push, Web Push, Telegram, ServerChan, QQ Bot or voice."
---

# Notifications

Get notified when sessions need input, request permissions, fail, or complete — via native app notifications, Telegram, Server酱 (ServerChan), QQ Bot, Web Push, or voice.

Web Push needs no provider configuration: [install the PWA](./pwa.md) and allow notifications. The channels below are optional.

## Native app notifications

See [Native apps](./native-apps.md) for install, pairing and platform requirements.

For the App Store and Google Play apps, pair an updated hub and allow notifications.
No Firebase project or Apple developer account is needed. Notification content
is end-to-end encrypted through the official push relay, which also works when
you access the hub through Tailscale or your own HTTPS setup. Android requires
Google Play services and FCM connectivity.

Private app builds need matching Firebase/APNs credentials. An Android build
without Firebase configuration has no FCM push. For a self-signed iOS build,
the signing account, bundle ID and APNs environment must match the provider
configuration; the official relay cannot deliver to an arbitrary self-build.
See the [native push contract](../api/native-companion-contract.md) for settings
and delivery details. This push relay is independent of the `--relay` network
tunnel.

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

Then message your bot with `/start`, open the app, and bind using
`CLI_API_TOKEN:<namespace>` (for example, `your-token:default`).

Related environment variables:

- `TELEGRAM_NOTIFICATION` - Enable/disable Telegram notifications (default: `true`)

**Troubleshooting:**

- If binding fails, verify `HAPI_PUBLIC_URL` is accessible from the internet
- Telegram Mini App requires HTTPS (not HTTP)

## ServerChan (Server酱) Setup

Server酱 pushes notifications to WeChat and other channels. The hub sends ServerChan messages when a session is ready for input, requests a permission, or a session completes.

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

## QQ Bot setup (direct messages)

An official QQ bot can notify one recipient when a HAPI session is ready for input,
requests permission or input, or completes normally. It sends only direct messages;
groups, inbound messages, and approval actions are not supported.

1. Create or use an existing bot on the [QQ Open Platform](https://q.qq.com/) and obtain its App ID and App Secret.
2. Set up a direct chat with the bot and make sure the recipient allows proactive messages. Obtain the `user_openid` for this bot (for example, from the sender information in an incoming direct-message event handled by your existing bot integration). This is not the recipient's QQ number, and an OpenID for another bot will not work. HAPI does not receive QQ events or discover this ID for you.
3. Configure the hub and restart it. Use an explicit `HAPI_PUBLIC_URL` that you can open from the device receiving the notification.

```bash
export QQBOT_NOTIFICATION=true
export QQBOT_APP_ID="your-app-id"
export QQBOT_APP_SECRET="your-app-secret"
export QQBOT_USER_OPENID="the-recipients-openid-for-this-bot"
export HAPI_PUBLIC_URL="https://hapi.example.com"

hapi hub
```

- Set `QQBOT_NAMESPACE` if the recipient should receive notifications for a namespace other than `default`. A destination never receives notifications from another namespace.
- Set `QQBOT_BACKGROUND_ONLY=true` to suppress these notifications while a visible HAPI client is connected in that namespace.
- The notification includes the first eight characters of the session ID and a link. HAPI does not send session names, summaries, workspace paths, permission arguments, or conversation contents to QQ. The link does not grant access to HAPI. If QQ asks you to use an external browser, open it there and sign in as usual.
- Equivalent `qqBot` settings are listed in the [configuration reference](./configuration.md#notifications). Environment overrides win and are not copied into `settings.json`.
- QQ applies [proactive message permissions and rate limits](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html). If delivery fails, check the Hub log for the HTTP status or QQ error code, then verify the recipient's OpenID and proactive-message permissions in QQ.

## Voice assistant setup

Enable voice control:

1. Get an API key from [elevenlabs.io](https://elevenlabs.io/app/settings/api-keys)
2. Set the environment variable:

```bash
export ELEVENLABS_API_KEY="your-api-key"
hapi hub --relay
```

See [Voice Assistant](./voice-assistant.md) for usage details.
