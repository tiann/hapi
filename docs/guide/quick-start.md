# Quick Start

<Steps>

## Install HAPI

::: code-group

```bash [npm]
npm install -g @twsxtd/hapi
```

```bash [Homebrew]
brew install tiann/tap/hapi
```

```bash [npx (one-off)]
npx @twsxtd/hapi
```

:::

Other install options: [Installation](/guide/installation)

## Start the server

```bash
hapi server
```

On first run, HAPI prints an access token and saves it to `~/.hapi/settings.json`.

## Start a coding session

```bash
hapi
```

This starts Claude Code wrapped with HAPI. The session appears in the web UI.

## Open the UI

Open your browser:

```
http://localhost:3006
```

Or from another device on the same network:

```
http://<your-computer-ip>:3006
```

Enter your access token to log in.

</Steps>

## Next steps

- [Remote access](/guide/installation#remote-access) - Access HAPI from anywhere
- [Notifications](/guide/installation#telegram-setup) - Set up Telegram notifications
- [Install the app](/guide/pwa) - Add HAPI to your home screen
