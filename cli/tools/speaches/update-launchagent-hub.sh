#!/usr/bin/env bash
set -euo pipefail

cat > "$HOME/Library/LaunchAgents/com.hapi.hub.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hapi.hub</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/jordan/.bun/bin/bun</string>
        <string>--watch</string>
        <string>run</string>
        <string>src/index.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/jordan/Documents/Projects/hapi/hub</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>LOCAL_WHISPER_URL</key>
        <string>http://127.0.0.1:8000</string>
        <key>LOCAL_WHISPER_MODEL</key>
        <string>whisper-1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/jordan/.hapi/logs/hub.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/jordan/.hapi/logs/hub.log</string>
</dict>
</plist>
PLIST

plutil -lint "$HOME/Library/LaunchAgents/com.hapi.hub.plist"
launchctl bootout "gui/$(id -u)/com.hapi.hub" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.hapi.hub.plist"
launchctl kickstart -k "gui/$(id -u)/com.hapi.hub"
launchctl print "gui/$(id -u)/com.hapi.hub" | sed -n '1,80p'
