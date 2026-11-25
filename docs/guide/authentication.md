---
description: "How CLIs, runners, the web app, native apps and Telegram sign in to a HAPI hub: the access token, QR sign-in, passkeys, JWT lifetimes and token rotation."
---

# Authentication

Everything that signs in to a HAPI hub — CLIs, runners, the web app, the
native apps and Telegram — ultimately depends on one secret: the hub's
**access token** (`CLI_API_TOKEN`). This page explains each sign-in path, how
sessions are kept alive, and what rotating the token revokes.

| Client | Signs in with | Details |
|--------|---------------|---------|
| CLI and runner | Access token | [CLI and runner](#cli-and-runner) |
| Web app / PWA | Access token (typed, or from a QR/URL), then optionally a passkey | [Web app](#web-app) |
| iOS / Android apps | Pairing QR or typed token, then optionally a passkey | [Native apps](#native-apps) |
| Telegram Mini App | Telegram account bound once with the access token | [Telegram](#telegram) |

## Access token

On first start, `hapi hub` generates a random 256-bit token, prints it, and
saves it as `cliApiToken` in `~/.hapi/settings.json`. To use your own token,
set `CLI_API_TOKEN` in the hub's environment; it takes precedence over the
file. The hub warns at startup if that token looks weak.

```bash
# Show the token on the hub machine
grep cliApiToken ~/.hapi/settings.json
```

Treat the token like a password. Anyone who has it can control every session
in its namespace, and a web QR code or `?token=` link contains it in plain
text.

### Namespaces

A client may append `:<namespace>` to the token, for example
`your-token:alice`. The hub splits on the **last** `:`; without a suffix the
namespace is `default`. Each namespace sees only its own sessions, machines,
passkeys and Telegram bindings. The hub's own `CLI_API_TOKEN` must be the base
token without a suffix; the hub refuses to start otherwise. See
[Namespaces](./namespace.md).

## CLI and runner

The CLI and runner authenticate to the hub's `/cli` Socket.IO namespace and
`/cli` REST routes with the access token (including any `:<namespace>`
suffix). The CLI looks for it in this order:

1. `CLI_API_TOKEN` environment variable
2. `cliApiToken` in `~/.hapi/settings.json`
3. An interactive prompt on first run, which saves the answer to
   `settings.json`. Non-interactive runs fail instead.

```bash
hapi auth login    # Prompt for the token and save it
hapi auth status   # Show hub URL, whether a token is set, and its source
hapi auth logout   # Remove the saved token and this machine's ID
```

`hapi auth logout` does not unset a `CLI_API_TOKEN` environment variable.

On the hub machine itself, the CLI and hub share `settings.json`, so a local
`hapi` works without extra setup. For a remote hub, also set `HAPI_API_URL`
(or `apiUrl` in settings). Access proxies such as Cloudflare Access can be
satisfied with `HAPI_EXTRA_HEADERS_JSON`. See
[Configuration](./configuration.md#cli).

## Web app

1. Open the hub URL (for example `http://localhost:3006`), or the address
   printed by `hapi hub --relay`.
2. Enter the access token, with `:<namespace>` if you use namespaces.

With `--relay`, the terminal also prints a link and QR code of the form
`https://app.hapi.run/?hub=<hub-url>&token=<access-token>`. Opening it signs
in without typing. The web app keeps the access token in the browser's local
storage for that hub so it can renew its session.

The official web app at `app.hapi.run` and other separately hosted web apps
ask for the **Hub URL** before signing in.

### Passkeys

After the first sign-in with the token, you can register a passkey (Face ID,
Touch ID, Windows Hello, Android, or a security key) and stop keeping the
access token in the browser. See [PWA → Passkey sign-in](./pwa.md#passkey-sign-in)
for the steps in the web app.

Requirements:

- **`HAPI_PUBLIC_URL` must be the hub's canonical HTTPS origin**, such as
  `https://hapi.example.com`: HTTPS, no path, query or credentials. Without
  it, passkey requests fail with “Configure HAPI_PUBLIC_URL as the canonical
  HTTPS Hub origin to use passkeys”. Clients must reach the hub through that
  same origin.
- The web app must be served over HTTPS and allowed to open a popup.
- A separately hosted web app needs its exact origin in the hub's
  `CORS_ORIGINS`; `*` is not enough to receive the sign-in callback.

How it works: all HAPI passkeys use the shared relying party
`auth.hapi.run`. Registration and browser sign-in open a small static page on
that domain, which runs the WebAuthn ceremony and posts the result straight
back to your hub. It never receives your access token, and it stores nothing:
public keys and the passkey-to-namespace mapping live in your hub's database.
The ceremony is bound to your hub's origin, so another hub cannot reuse it.

A passkey registered in the web app also works in the iOS and Android apps for
the same hub and namespace, and vice versa. Passkeys from the earlier
per-domain design must be registered again.

To remove a passkey, open **Settings → Passkeys** and choose **Remove**.
Removal takes effect immediately on every device that signed in with it.

## Native apps

Pair the iOS or Android app by scanning the hub's QR code, opening a
`hapicompanion://bind?hub=<url>&code=<access-token>` link, or typing the hub
URL and access token. Use an HTTPS hub URL; Android rejects HTTP. See
[Native apps → Pair with your hub](./native-apps.md#pair-with-your-hub).

Passkeys added in the app (**Settings → Passkeys**) sync through iCloud
Keychain or Google Password Manager. On a new device, choose **Sign in with a
passkey**:

- **One system prompt.** The app signs a fresh challenge it created itself,
  reads the hub address stored in the selected passkey, and sends the
  assertion only to that hub. The hub accepts such a challenge once, and only
  if it was created within the last five minutes.
- **Hub discovery.** You do not type the hub URL. Hubs with very long host
  names store only a hash of their address in the passkey; for those, and when
  you want a specific hub, enter the hub URL manually. The app checks that the
  passkey belongs to that hub before sending anything.

The official apps are trusted by the hub out of the box. If you build and sign
the Android app yourself, add its signing-certificate origin to
`HAPI_PASSKEY_NATIVE_ORIGINS` on the hub
(`android:apk-key-hash:<base64url SHA-256>`, comma-separated). Self-built iOS
apps need their own associated domain, which requires changing the shared
relying party; that is not supported by configuration alone.

## Telegram

When `TELEGRAM_BOT_TOKEN` is set, the hub's bot can open HAPI as a Telegram
Mini App. The first time, the Mini App asks for the access token
(`token:<namespace>` if you use namespaces) and binds your Telegram account to
that namespace. Later sign-ins use only Telegram's signed launch data. A
Telegram account can be bound to one namespace. See
[Notifications → Telegram setup](./notifications.md#telegram-setup).

## Sessions and refresh

Each client exchanges its credential at `POST /api/auth` for a short-lived
**JWT** used on all API requests, the live event stream, and web terminals.

| Credential | Lifetime | Renewed by |
|------------|----------|------------|
| JWT | 4 hours | Exchanging the stored credential again |
| Passkey session | 30 days | Signing in with the passkey again |
| Access token | Until rotated | – |

After a passkey sign-in, the client stores a 30-day **passkey session**
instead of the access token. It cannot be used as an API token; the hub only
exchanges it for a JWT after checking that the passkey still exists and is
still valid. JWTs are signed with a hub-local key in
`~/.hapi/jwt-secret.json`.

The precise client contract, including 401 handling, is in the
[Auth & pairing contract](../api/client-contract/auth.md).

## Rotating the access token

Rotate the token when it may have leaked or someone should lose access:

1. Set the new token on the hub: change `CLI_API_TOKEN` in its environment,
   or, if you do not set it there, edit `cliApiToken` in the hub's
   `settings.json`. The environment variable wins over the file.
2. Restart the hub.
3. On every machine, run `hapi auth login` (or update `CLI_API_TOKEN`) and
   restart the runner with `hapi runner start`.
4. Sign in again on each web browser and native device with the new token,
   and add passkeys again.

What rotation revokes:

| Credential | After rotation |
|------------|----------------|
| CLI and runner connections | New connections with the old token are rejected. |
| Stored access tokens in browsers and apps | Rejected at the next renewal; the client asks you to sign in again. |
| Passkeys and passkey sessions | All are disabled, and Settings shows them as inactive. Remove them and register new ones. |
| JWTs already issued | **Not revoked.** They keep working until they expire, at most 4 hours. |
| Telegram bindings | **Not revoked.** Bound Telegram accounts keep signing in. |

To invalidate issued JWTs immediately, also stop the hub, delete
`~/.hapi/jwt-secret.json`, and start it again; a new signing key is
generated. To remove a single device without rotating, delete the passkey it
used.
