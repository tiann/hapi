# Deployment

Run the hub and runner as persistent background services, and configure remote access tunnels.

## Relay tunnel details

The default public relay (`hapi hub --relay`) works out of the box. This section covers how relay authentication works and how to tune it.

The hub automatically stores an individually revocable relay key in `settings.json` (`relayAuthKey`). If that persisted key is revoked or the relay rotates its signing secret, HAPI discards it after HTTP 403, requests one replacement, and restarts the tunnel. Relay issuance is limited per public IP; HTTP 429 is reported explicitly, which can affect users sharing a CGNAT or corporate egress address. Set `HAPI_RELAY_AUTH` only when an operator has provided a key manually; rejected environment keys are never overwritten automatically.

> **Tip:** The relay uses UDP by default. If you experience connectivity issues, set `HAPI_RELAY_FORCE_TCP=true` to force TCP mode.

Other relay-related environment variables:

- `HAPI_RELAY_API` - Relay API domain (default: `relay.hapi.run`)
- `HAPI_OFFICIAL_WEB_URL` - Official web app origin allowed via CORS when the relay is enabled (default: `https://app.hapi.run`)

## Self-hosted tunnels

If you prefer not to use the public relay (e.g., for lower latency or self-managed infrastructure), you can use these alternatives:

<details>
<summary>Cloudflare Tunnel</summary>

https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

> **Note:** Cloudflare Quick Tunnels (TryCloudflare) are not supported because they [do not support SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/), which HAPI uses for real-time updates. Use a Named Tunnel instead.

**Named tunnel setup:**

```bash
# Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Create and configure a named tunnel
cloudflared tunnel create hapi
cloudflared tunnel route dns hapi hapi.yourdomain.com

# Run the tunnel
cloudflared tunnel --protocol http2 run hapi
```

> **Tip:** Use `--protocol http2` instead of QUIC (the default) to avoid potential timeout issues with long-lived connections.

</details>

<details>
<summary>Tailscale</summary>

https://tailscale.com/download

```bash
sudo tailscale up
hapi hub
```

Access via your Tailscale IP:

```
http://100.x.x.x:3006
```
</details>

<details>
<summary>Public IP / Reverse Proxy</summary>

If the hub has a public IP, access directly via `http://your-hub-ip:3006`.

Use HTTPS (via Nginx, Caddy, etc.) for production.

**Self-signed certificates (HTTPS)**

If `HAPI_API_URL` is set to an `https://...` URL with a self-signed (or otherwise untrusted) certificate, the CLI may fail with:

```
Error: self signed certificate
```

Recommended fixes (in order):

1. Use a publicly trusted certificate (e.g., Let's Encrypt)
2. Trust your private CA (recommended for private networks)
3. Dev-only workaround: disable TLS verification (insecure)

```bash
# Preferred: trust your own CA
export NODE_EXTRA_CA_CERTS="/path/to/your-ca.pem"

# Dev-only workaround: disable TLS verification (INSECURE)
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

If you use the dev-only workaround, assume MITM risk; do not use on public networks.

</details>

## Background service deployment

Keep HAPI running persistently so it survives terminal closes, system restarts, and continues running in the background.

<details>
<summary>Quick: nohup</summary>

Simple one-liner for quick background runs:

```bash
# Hub
nohup hapi hub --relay > ~/.hapi/logs/hub.log 2>&1 &

# Runner
nohup hapi runner start-sync > ~/.hapi/logs/runner.log 2>&1 &
```

View logs:

```bash
tail -f ~/.hapi/logs/hub.log
tail -f ~/.hapi/logs/runner.log
```

Stop processes:

```bash
pkill -f "hapi hub"
pkill -f "hapi runner"
```
</details>

<details>
<summary>pm2 (recommended for Node.js users)</summary>

pm2 provides process management with auto-restart on crashes and system reboot.

```bash
# Install pm2
npm install -g pm2

# Start hub and runner
pm2 start "hapi hub --relay" --name hapi-hub
# HAPI_RUNNER_SUPERVISED=1 lets the web Restart button stop the runner knowing
# pm2 will cold-start it again (unsupervised stop would leave the host offline).
HAPI_RUNNER_SUPERVISED=1 pm2 start "hapi runner start-sync" --name hapi-runner

# View status and logs
pm2 status
pm2 logs hapi-hub
pm2 logs hapi-runner

# Auto-restart on system reboot
pm2 startup    # Follow the printed instructions
pm2 save       # Save current process list
```
</details>

<details>
<summary>macOS: launchd</summary>

Create plist files for automatic startup on macOS.

**Hub** (`~/Library/LaunchAgents/com.hapi.hub.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string>
        <string>hub</string>
        <string>--relay</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/hub.log</string>
</dict>
</plist>
```

**Runner** (`~/Library/LaunchAgents/com.hapi.runner.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.runner</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/hapi</string>
        <string>runner</string>
        <string>start-sync</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HAPI_RUNNER_SUPERVISED</key>
        <string>1</string>
    </dict>
    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>65536</integer>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/YOUR_USERNAME/.hapi/logs/runner.log</string>
</dict>
</plist>
```

Load/unload services:

```bash
# Load (start)
launchctl load ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl load ~/Library/LaunchAgents/com.hapi.runner.plist

# Unload (stop)
launchctl unload ~/Library/LaunchAgents/com.hapi.hub.plist
launchctl unload ~/Library/LaunchAgents/com.hapi.runner.plist
```

> **macOS sleep note:** macOS may suspend background processes when the display sleeps. Use `caffeinate` to prevent this:
> ```bash
> caffeinate -dimsu hapi hub --relay
> ```
> Or run `caffeinate -dimsu` in a separate terminal while HAPI is running.
</details>

<details>
<summary>Linux: systemd</summary>

Create user-level systemd services for automatic startup.

**Hub** (`~/.config/systemd/user/hapi-hub.service`):

```ini
[Unit]
Description=HAPI Hub
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/hapi hub --relay
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

**Runner** (`~/.config/systemd/user/hapi-runner.service`):

```ini
[Unit]
Description=HAPI Runner
After=network.target hapi-hub.service

[Service]
Type=simple
KillMode=process
# Advertise supervisedRestart so the web UI Restart button may stop-runner
# knowing systemd will cold-start the unit again.
Environment=HAPI_RUNNER_SUPERVISED=1
ExecStart=/usr/local/bin/hapi runner start-sync
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

> **Why `KillMode=process`?** The runner spawns each agent session as a detached child process (`detached: true` in `cli/src/runner/run.ts`) so that sessions stay alive when the runner exits. Without `KillMode=process`, systemd's default `KillMode=control-group` sends SIGTERM to every PID in the runner's cgroup when the unit stops, defeating the detach and forcibly archiving every running session. `KillMode=process` preserves the contract: stopping or restarting the runner only signals the runner itself; agent sessions stay alive, and a fresh runner re-establishes control via the existing socket.io reconnect path. This applies to runner upgrades, manual restarts, and any reboot in which the runner unit is stopped before agents have finished.

Enable and start:

```bash
# Reload systemd
systemctl --user daemon-reload

# Enable (auto-start on login)
systemctl --user enable hapi-hub
systemctl --user enable hapi-runner

# Start now
systemctl --user start hapi-hub
systemctl --user start hapi-runner

# View status/logs
systemctl --user status hapi-hub
journalctl --user -u hapi-hub -f
```

> **Persist after logout:** To keep services running even when not logged in:
> ```bash
> loginctl enable-linger $USER
> ```
</details>
