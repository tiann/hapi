# FAQ

## General

### What is HAPI?

HAPI is a local-first, self-hosted platform for running and controlling AI coding agents remotely (Claude Code, Codex, Cursor Agent, Grok Build, OpenCode, and more — see [Supported Agents](./agents.md)). It lets you start coding sessions on your computer and monitor/control them from your phone.

### What does HAPI stand for?

HAPI (哈皮) is a Chinese transliteration of "Happy", reflecting the project's goal of making AI coding assistance a happier experience by freeing you from the terminal.

### Is HAPI free?

Yes, HAPI is open source and free to use under the AGPL-3.0-only license.

### What AI agents does HAPI support?

HAPI supports several coding agents, with Claude Code as the recommended option. See [Supported Agents](./agents.md) for the full list and per-agent setup notes.

## Setup & Installation

### Do I need a hub?

HAPI includes an embedded hub. Just run `hapi hub` on your machine - no external hub required.

`hapi server` remains supported as an alias.

### How do I access HAPI from my phone?

For local network access:
```
http://<your-computer-ip>:3006
```

If your phone cannot connect, make sure the hub is not only listening on `127.0.0.1`. For LAN access, set `listenHost` to `0.0.0.0` in `~/.hapi/settings.json` or set `HAPI_LISTEN_HOST=0.0.0.0`, then restart `hapi hub`.

For internet access:
- Use the built-in relay tunnel: start the hub with `hapi hub --relay` to get a public URL via the tunwg relay (defaults to the official `relay.hapi.run`)
- If the hub has a public IP, access it directly (use HTTPS via reverse proxy for production)
- If behind NAT, set up your own tunnel (Cloudflare Tunnel, Tailscale, or ngrok)

### What's the access token for?

The `CLI_API_TOKEN` is a shared secret that authenticates:
- CLI connections to the hub
- Web app logins
- Telegram account binding

It's auto-generated on first hub start and saved to `~/.hapi/settings.json`.

### Do you support multiple accounts?

Yes. We support lightweight multi-account access via namespaces for shared team hubs. See [Namespace (Advanced)](./namespace.md).

### Can I use HAPI without Telegram?

Yes. Telegram is optional. You can use the web app directly in any browser or install it as a PWA.

## Usage

### How do I approve permissions remotely?

1. When your AI agent requests permission (e.g., to edit a file), you'll see a notification
2. Open HAPI on your phone
3. Navigate to the active session
4. Approve or deny the pending permission

### How do I receive notifications?

HAPI supports three methods:

1. **PWA Push Notifications** - Enable when prompted, works even when app is closed
2. **Telegram Bot** - See [Telegram Setup](./notifications.md#telegram-setup)
3. **FCM native push** - Used by the Android/Wear OS companion apps; notifications are delivered via Firebase Cloud Messaging

### Can I start sessions remotely?

Yes, with runner mode:

1. Run `hapi runner start` on your computer
2. Your machine appears in the "Machines" list in the web app
3. Tap to spawn new sessions from anywhere

### How do I see what files were changed?

In the session view, tap the "Files" tab to:
- Browse project files
- View git status
- See diffs of changed files

### Can I send messages to the AI from my phone?

Yes. Open any session and use the chat interface to send messages directly to the AI agent.

### Can I access a terminal remotely?

Yes. Open a session in the web app and tap the Terminal tab for a remote shell.

Linux and macOS hosts use Bun's POSIX PTY support. Windows hosts use Bun's ConPTY support, which requires Bun 1.3.14 or newer.

### How do I use voice control?

The voice assistant supports three backends: ElevenLabs, Gemini Live, and Qwen Realtime. Configure at least one, open a session in the web app, and click the microphone button. See [Voice Assistant](./voice-assistant.md) for setup details.

## Security

### Is my data safe?

Yes. HAPI is local-first:
- All data stays on your machine
- Nothing is uploaded to external servers
- The database is stored locally in `~/.hapi/`

### How secure is the token authentication?

The auto-generated token is 256-bit (cryptographically secure). For external access, always use HTTPS via a tunnel.

### Can others access my HAPI instance?

Only if they have your access token. For additional security:
- Use a strong, unique token
- Always use HTTPS for external access
- Consider Tailscale for private networking

## Troubleshooting

### "Connection refused" error

- Ensure hub is running: `hapi hub`
- Check firewall allows port 3006
- Verify `HAPI_API_URL` is correct

### My phone cannot access HAPI on the local network

If HAPI works on your computer but not from another device on the same LAN, check the hub bind address first. By default, HAPI listens on `127.0.0.1`, which only accepts localhost connections.

Use one of these:

```json
{
  "listenHost": "0.0.0.0"
}
```

```bash
export HAPI_LISTEN_HOST=0.0.0.0
```

Then restart `hapi hub` and open:

```bash
http://<your-computer-ip>:3006
```

Also verify your OS firewall allows inbound connections on port `3006`.

### "Invalid token" error

Run `hapi doctor` first - it shows whether `CLI_API_TOKEN` is set and where it comes from (environment variable or settings file).

- Re-run `hapi auth login`
- Check token matches in CLI and hub
- Verify `~/.hapi/settings.json` has correct `cliApiToken`

### Runner won't start

Run `hapi doctor` first - it shows runner status (including stale state), all hapi processes, and recent log files.

```bash
# Check status
hapi runner status

# List sessions the runner is aware of
hapi runner list

# Stop a specific runner-spawned session
hapi runner stop-session <session-id>

# Clear stale lock file
rm ~/.hapi/runner.state.json.lock

# Check logs
hapi runner logs

# Kill runaway hapi processes
hapi doctor clean
```

### Claude Code not found

Install Claude Code or set custom path:
```bash
npm install -g @anthropic-ai/claude-code
# or
export HAPI_CLAUDE_PATH=/path/to/claude
```

### Cursor Agent not found

Install Cursor Agent CLI:
```bash
# macOS/Linux
curl https://cursor.com/install -fsS | bash

# Windows (PowerShell)
irm 'https://cursor.com/install?win32=true' | iex
```

Ensure `agent` is on your PATH.

### How do I run diagnostics?

```bash
hapi doctor
```

This is the first diagnostic step for most issues. It prints:

- CLI version, platform, and spawn diagnostics
- Configuration and relevant environment variables
- Contents of `settings.json` (token redacted)
- Whether `CLI_API_TOKEN` is set, and its source (it does not contact the hub or validate the token)
- Runner status and runner state (including stale state)
- All running hapi processes
- Recent log files (including runner logs)

To clean up runaway processes:

```bash
hapi doctor clean
```

## Comparison

### HAPI vs Happy

| Aspect | Happy | HAPI |
|--------|-------|------|
| Design | Cloud-first | Local-first |
| Users | Multi-user | Single user by default; lightweight multi-account isolation via [namespaces](./namespace.md) |
| Deployment | Multiple services | Single binary |
| Data | Encrypted on server | Never leaves your machine |

See [Why HAPI](./why-hapi.md) for detailed comparison.

### HAPI vs running Claude Code directly

| Feature | Claude Code | HAPI + Claude Code |
|---------|-------------|-------------------|
| Remote access | No | Yes |
| Mobile control | No | Yes |
| Permission approval | Terminal only | Phone/web |
| Session persistence | No | Yes |
| Multi-machine | Manual | Built-in |

## Contributing

### How can I contribute?

Visit our [GitHub repository](https://github.com/tiann/hapi) to:
- Report issues
- Submit pull requests
- Suggest features

### Where do I report bugs?

Open an issue on [GitHub Issues](https://github.com/tiann/hapi/issues).
