---
description: "Install the HAPI CLI (Homebrew, npm, npx, binary or source), start the hub, choose a remote access option, and connect the web or native apps."
---

# Installation

Install the HAPI CLI and set up the hub. To install the paid phone apps and
pair them, see [Native apps (iOS / Android)](./native-apps.md); for the free
browser client, see [PWA](./pwa.md).

## Prerequisites

- At least one supported agent CLI installed (Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, DeepSeek Harness ACP server, and more — see [Supported Agents](./agents.md))

Check that the agent you plan to use runs on its own first, for example
`claude --version` or `codex --version`. [Supported Agents](./agents.md) lists
the command and install steps for each agent.

## Architecture

HAPI uses these runtime roles:

| Component | Role | Required |
|-----------|------|----------|
| **CLI** | Wraps AI coding agents, runs sessions | Yes |
| **Hub** | Central coordinator: persistence, real-time sync, remote access | Yes |
| **Runner** | Background service for remote session spawning | Optional |
| **Client** | Native iOS/Android, Web/PWA or Telegram Mini App | One client for remote control |

### How they work together

The CLI and Runner connect to the hub over Socket.IO; clients send actions
through REST and receive live updates through SSE. The Runner spawns CLI
sessions when requested through the hub. See the [architecture overview](./how-it-works.md#architecture-overview).

- **CLI**: Choose an agent with `hapi`, or start one directly with `hapi <agent>`. The CLI wraps your AI agent and syncs with the hub. Scripts must specify the agent explicitly.
- **Hub**: Run `hapi hub`. Stores sessions, handles permissions, enables remote access.
- **Runner**: Run `hapi runner start`. Lets you spawn sessions from native or web clients without keeping a terminal open.
- **Client**: Pair a native app with the HTTPS hub origin and access token, or log in through the web app.

### Typical workflows

**Local only**: `hapi hub` → `hapi` → work in terminal

**Remote access**: `hapi hub --relay` → `hapi runner start` → pair a native app or open the web app

## Install the CLI

```bash
npm install -g @twsxtd/hapi --registry=https://registry.npmjs.org
```

> Recommendation: use the official npm registry for global install. Some mirrors may not sync platform packages in time.

Or with Homebrew:

```bash
brew install tiann/tap/hapi
```

### Upgrades that still run an older version

The `@twsxtd/hapi` package is a launcher. Its platform binary (for example,
`@twsxtd/hapi-darwin-arm64`) is an optional dependency pinned to the same version.
If a mirror has the new launcher but not the matching platform package, the
package manager can finish upgrading the launcher while skipping the binary.
A previous binary may remain installed. Older launchers can silently run it;
launchers with version validation instead report a version mismatch.

Retry against the official registry using your existing package manager. For Bun:

```bash
bun remove -g @twsxtd/hapi && bun add -g @twsxtd/hapi@latest --registry=https://registry.npmjs.org
hapi --version
```

Removing the launcher first clears its dependency resolution; `--force` alone
can leave a previously skipped platform package out of Bun's lockfile. This does
not remove your HAPI settings or sessions. To stay on a specific release, replace
`latest` with that version. For npm, use
`npm install -g @twsxtd/hapi@latest --registry=https://registry.npmjs.org`.
If the command still reports an old version, check for another HAPI installation
earlier on `PATH`. Restart an already-running hub or runner after upgrading;
installing a new binary does not replace running processes.

## Other install options

<details>
<summary>npx (no install)</summary>

```bash
npx @twsxtd/hapi
```
</details>

<details>
<summary>Prebuilt binary</summary>

Download the latest release from [GitHub Releases](https://github.com/tiann/hapi/releases).

```bash
xattr -d com.apple.quarantine ./hapi
chmod +x ./hapi
sudo mv ./hapi /usr/local/bin/
```
</details>

<details>
<summary>Build from source</summary>

Requires Bun 1.4.4.

```bash
git clone https://github.com/tiann/hapi.git
cd hapi
bun install
bun build:single-exe

./cli/dist-exe/<target>/hapi
```

`<target>` is the Bun build target (e.g., `bun-linux-x64`, `bun-darwin-arm64`); it defaults to the host platform and architecture.
</details>

## Hub setup

The hub can be deployed on:

- **Local desktop** (default) - Run on your development machine
- **Remote host** - Deploy the hub on a VPS, cloud host, or any machine with network access

### Default: Public Relay (recommended)

```bash
hapi hub --relay
```

The terminal displays a URL and QR code. Scan to access from anywhere.

`hapi server` remains supported as an alias.

- **End-to-end encrypted** with WireGuard + TLS
- No configuration needed
- Works behind NAT, firewalls, and any network

For relay key management, TCP fallback, and self-hosted tunnel alternatives, see [Deployment](./deployment.md#relay-tunnel-details).

### Local Only

```bash
hapi hub
# or
hapi hub --no-relay
```

The hub listens on `http://localhost:3006` by default. Use `--host` and
`--port` to change the bind address and port:

```bash
hapi hub --host 0.0.0.0 --port 8080
```

They set `HAPI_LISTEN_HOST` / `HAPI_LISTEN_PORT`. Like those variables, they
are saved to `settings.json` when `listenHost` / `listenPort` is not set
there yet, so later runs keep them; edit `settings.json` to change a saved
value. Binding to `0.0.0.0` exposes the hub to your network; restrict access
with a firewall.

On first run, HAPI:

1. Creates `~/.hapi/`
2. Generates a secure access token
3. Prints the token and saves it to `~/.hapi/settings.json`

Open the web app and sign in with that token. After the first sign-in you can
add a passkey so you no longer need the token in the browser or app; see
[Authentication](./authentication.md).

<details>
<summary>Config files</summary>

```
~/.hapi/
├── settings.json      # Main configuration
├── hapi.db           # SQLite database (hub)
├── runner.state.json  # Runner process state
└── logs/             # Log files
```
</details>

### Common settings

Configuration priority is **environment variable > `settings.json` >
default**. The hub saves environment values it sees to `settings.json` the
first time. The most common settings:

| Variable | `settings.json` | Default | Purpose |
|----------|-----------------|---------|---------|
| `CLI_API_TOKEN` | `cliApiToken` | Auto-generated | Access token |
| `HAPI_API_URL` | `apiUrl` | `http://localhost:3006` | Hub URL used by the CLI and runner |
| `HAPI_LISTEN_HOST` | `listenHost` | `127.0.0.1` | Hub bind address |
| `HAPI_LISTEN_PORT` | `listenPort` | `3006` | Hub port |
| `HAPI_PUBLIC_URL` | `publicUrl` | – | Public HTTPS origin; required for passkeys and Telegram |
| `CORS_ORIGINS` | `corsOrigins` | From `publicUrl` | Allowed web origins |
| `HAPI_HOME` | – | `~/.hapi` | Data directory |

See the [Configuration reference](./configuration.md) for every variable,
including notifications, voice, generated titles, upload limits and agent
paths.

<details>
<summary>settings.json example</summary>

```json
{
  "$schema": "https://hapi.run/docs/schemas/settings.schema.json",
  "listenHost": "0.0.0.0",
  "listenPort": 3006,
  "publicUrl": "https://your-domain.com",
  "extraHeaders": {
    "Cookie": "CF_Authorization=..."
  }
}
```

`extraHeaders` (`HAPI_EXTRA_HEADERS_JSON`) is never saved from the
environment, so access credentials are not persisted unexpectedly.

JSON Schema: [settings.schema.json](https://hapi.run/docs/schemas/settings.schema.json)
</details>

## CLI setup

If the hub is not on localhost, set these before running `hapi`:

```bash
export HAPI_API_URL="http://your-hub:3006"
export CLI_API_TOKEN="your-token-here"
export HAPI_EXTRA_HEADERS_JSON='{"Cookie":"CF_Authorization=..."}'
```

Or use interactive login:

```bash
hapi auth login
```

Authentication commands:

```bash
hapi auth status
hapi auth login
hapi auth logout
```

See [Authentication](./authentication.md) for all sign-in methods and the
[CLI reference](./cli-reference.md) for every command.

Each machine gets a unique ID stored in `~/.hapi/settings.json`. This allows:

- Multiple machines to connect to one hub
- Remote session spawning on specific machines
- Machine health monitoring

### Diagnostics

Run `hapi doctor` for a full diagnostics report: configuration, runner status, logs, and relevant environment info.

```bash
hapi doctor          # Diagnostics report
hapi doctor clean    # Kill runaway hapi processes
```

## Runner setup

Run a background service for remote session spawning:

```bash
hapi runner start
hapi runner status
hapi runner logs
hapi runner stop
```

With the runner running:

- Your machine appears in the "Machines" list
- You can spawn sessions remotely from the web app
- Sessions persist even when the terminal is closed

#### Split hub + remote runner (peer discovery)

When the hub runs on one host and the runner on another, agents inside runner-spawned sessions should discover peers via MCP **`list_peers`** (same hub credentials as the session CLI). Prefer that over shelling `hapi ping-peer --list`.

```
[Hub host]  hapi hub          ← sessions DB + /api/sessions
     ▲
     │ HAPI_API_URL + CLI_API_TOKEN
     │
[Runner host]  hapi runner start  → spawns session CLIs
                     │
                     ▼
              agent session  → MCP list_peers / inspect_peer / ping_peer / spawn_peer
```

On the runner host, configure the **same** hub URL and token the hub uses:

```bash
export HAPI_API_URL="http://your-hub:3006"   # or Tailscale / public URL
export CLI_API_TOKEN="your-token-here"
# or: hapi auth login   # saves the token; still set HAPI_API_URL for a remote hub
hapi runner start
```

Session CLI may export an **explicit** non-default `HAPI_API_URL` (from env or settings) into child env so shell helpers hit the same remote hub. It does **not** mirror `CLI_API_TOKEN` into wrapped agents (settings/prompt-backed secrets stay out of agent env; a fresh `hapi` re-reads `~/.hapi/settings.json`, and systemd/env tokens already inherit). Prefer MCP `list_peers` inside a session. Web terminal PTYs still strip hub secrets. If `--list` fails with an auth/URL error, the message points at `hapi auth login` and the configured hub URL.

##### Disabling peer tools on a runner

Set `HAPI_DISABLE_PEER_TOOLS=1` (also `true`/`yes`) in the runner environment to stop wrapped agents from browsing, messaging, or spawning other HAPI sessions — for example when one agent digging through the session list and pinging peers pollutes other sessions' contexts. The switch is not advertised-then-refused: the `list_peers` / `inspect_peer` / `ping_peer` / `spawn_peer` MCP tools are not registered on the session MCP server and not passed to `--allowedTools` / `--tools`, the peer steer block is dropped from agent system prompts (a pasted `/sessions/<id>` citation only reminds the agent it is a hub path, not a local file), and the peer core refuses with an explicit `disabled` error as defense in depth — so `hapi ping-peer` / `hapi inspect-peer` / `hapi spawn-peer` from inside a wrapped agent shell fails loudly too. Scope the env to the runner (systemd unit, launchd plist, or runner guard script); operators who leave it unset in their interactive terminal keep full `hapi ping-peer` CLI access.

Additional runner commands:

```bash
hapi runner list                      # List active sessions
hapi runner stop-session <sessionId>  # Stop a single session managed by the runner
```

Use `--workspace-root <path>` to restrict which directories the runner can browse and spawn sessions in. Repeat the flag to allow multiple directories; supports `~` expansion:

```bash
hapi runner start --workspace-root ~/projects --workspace-root ~/work
```

Without `--workspace-root`, directory browsing and spawning both accept paths
anywhere the runner's OS account can access. The iOS directory picker starts
at the home directory and can navigate above it. Configuring roots restricts
both browsing and spawning to those roots, including symlink targets.

For running the hub and runner as persistent background services (pm2, launchd, systemd), see [Deployment](./deployment.md). Supervised installs should set `HAPI_RUNNER_SUPERVISED=1` on the runner process (systemd `Environment=` / pm2 `--env`) so the web **Restart** control can safely stop-runner knowing the supervisor will cold-start it.

### Multi-machine hubs

You can run **one hub** and **runners on many machines** (each machine installs its own CLI). When you upgrade the hub, upgrade the HAPI CLI on every machine that parents sessions. After the CLI binary on disk changes, that machine’s runner normally **self-restarts** via version handoff (unless `HAPI_DISABLE_VERSION_HANDOFF=1`). Until a runner reports the capabilities the hub requires, the web UI shows a **Runner out of date** banner (minimizable / snoozeable) with the host name and upgrade steps. The banner’s per-host **Restart** is only an escape hatch when handoff is stuck or disabled — the hub never downloads or installs packages on remotes.

## Security notes

- Keep tokens secret; see [Rotating the access token](./authentication.md#rotating-the-access-token) for what rotation revokes
- Use HTTPS for public access
- Restrict CORS origins in production

<details>
<summary>Firewall example (ufw)</summary>

```bash
ufw allow from 192.168.1.0/24 to any port 3006
```
</details>
