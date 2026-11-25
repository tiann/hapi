// A full thread/read or thread/resume reply can exceed 64 MiB for long sessions.
// Keep a finite bound on the authenticated loopback transport while allowing
// large histories to pass through both the gateway and app-server client.
export const CODEX_WEBSOCKET_MAX_PAYLOAD = 256 * 1024 * 1024;
