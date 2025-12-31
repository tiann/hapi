# FAQ

## General

### What is HAPI?

HAPI is a local-first, self-hosted platform for running and controlling AI coding agents (Claude Code, Codex, Gemini) remotely. It lets you start coding sessions on your computer and monitor/control them from your phone.

### What does HAPI stand for?

HAPI (哈皮) is a Chinese transliteration of "Happy", reflecting the project's goal of making AI coding assistance a happier experience by freeing you from the terminal.

### Is HAPI free?

Yes, HAPI is open source and free to use under the LGPL-3.0 license.

### What AI agents does HAPI support?

- **Claude Code** (recommended)
- **OpenAI Codex**
- **Google Gemini**

## Setup & Installation

### Do I need a server?

HAPI includes an embedded server. Just run `hapi server` on your machine - no external server required.

### How do I access HAPI from my phone?

For local network access:
```
http://<your-computer-ip>:3006
```

For internet access, set up a tunnel (Cloudflare Tunnel, Tailscale, or ngrok).

### What's the access token for?

The `CLI_API_TOKEN` is a shared secret that authenticates:
- CLI connections to the server
- Web app logins
- Telegram account binding

It's auto-generated on first server start and saved to `~/.hapi/settings.json`.

### Can I use HAPI without Telegram?

Yes. Telegram is optional. You can use the web app directly in any browser or install it as a PWA.

## Usage

### How do I approve permissions remotely?

1. When your AI agent requests permission (e.g., to edit a file), you'll see a notification
2. Open HAPI on your phone
3. Navigate to the active session
4. Approve or deny the pending permission

### Can I start sessions remotely?

Yes, with daemon mode:

1. Run `hapi daemon start` on your computer
2. Your machine appears in the "Machines" list in the web app
3. Tap to spawn new sessions from anywhere

### How do I see what files were changed?

In the session view, tap the "Files" tab to:
- Browse project files
- View git status
- See diffs of changed files

### Can I send messages to the AI from my phone?

Yes. Open any session and use the chat interface to send messages directly to the AI agent.

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

- Ensure server is running: `hapi server`
- Check firewall allows port 3006
- Verify `HAPI_SERVER_URL` is correct

### "Invalid token" error

- Re-run `hapi auth login`
- Check token matches in CLI and server
- Verify `~/.hapi/settings.json` has correct `cliApiToken`

### Daemon won't start

```bash
# Check status
hapi daemon status

# Clear stale lock file
rm ~/.hapi/daemon.state.json.lock

# Check logs
hapi daemon logs
```

### Claude Code not found

Install Claude Code or set custom path:
```bash
npm install -g @anthropic-ai/claude-code
# or
export HAPI_CLAUDE_PATH=/path/to/claude
```

### How do I run diagnostics?

```bash
hapi doctor
```

This checks server connectivity, token validity, agent availability, and more.

## Comparison

### HAPI vs Happy

| Aspect | Happy | HAPI |
|--------|-------|------|
| Design | Cloud-first | Local-first |
| Users | Multi-user | Single user |
| Deployment | Multiple services | Single binary |
| Data | Encrypted on server | Never leaves your machine |

See [Why HAPI](/guide/why-hapi) for detailed comparison.

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
