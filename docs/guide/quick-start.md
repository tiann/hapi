# Quick Start

Get HAPI running in a few minutes.

## Step 1: Install HAPI

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

## Step 2: Start the server

```bash
hapi server
```

On first run, HAPI prints an access token and saves it to `~/.hapi/settings.json`.

## Step 3: Start a coding session

```bash
hapi
```

This starts Claude Code wrapped with HAPI. The session appears in the web UI.

## Step 4: Open the UI

Open your browser:

```
http://localhost:3006
```

Or from another device on the same network:

```
http://<your-computer-ip>:3006
```

Enter your access token to log in.
