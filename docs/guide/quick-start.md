# Quick Start

<Steps>

## Install HAPI

```bash
npm install -g @twsxtd/hapi --registry=https://registry.npmjs.org
```

Other install options (Homebrew, npx, prebuilt binary, source): [Installation](./installation.md#install-the-cli)

## Start the hub

```bash
hapi hub --relay
```

On first run, HAPI prints an access token and saves it to `~/.hapi/settings.json`. The terminal displays a URL and QR code for remote access.

Details and local-only mode: [Hub setup](./installation.md#hub-setup)

## Start a coding session

```bash
hapi
```

This starts Claude Code wrapped with HAPI. The session appears in the web UI.

## Open the UI

Open the URL shown in the terminal, or scan the QR code with your phone.

Enter your access token to log in.

</Steps>

## Next steps

- [Seamless Handoff](./how-it-works.md#seamless-handoff) - Switch between terminal and phone seamlessly
- [Hub setup](./installation.md#hub-setup) - Access HAPI from anywhere
- [Notifications](./notifications.md#telegram-setup) - Set up Telegram or ServerChan notifications
- [Deployment](./deployment.md) - Run HAPI as a persistent background service
- [Install the App](./pwa.md) - Add HAPI to your home screen
