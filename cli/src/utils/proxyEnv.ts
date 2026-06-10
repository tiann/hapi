/**
 * Loopback proxy bypass.
 *
 * The CLI talks to itself and to local agents over loopback HTTP (hook
 * forwarder -> hook server, control client -> runner, claude -> local MCP
 * server). Bun's fetch AND its node:http implementation honor the
 * HTTP_PROXY/HTTPS_PROXY env vars, so when the user's shell exports a proxy
 * (e.g. Surge/Clash with `HTTP_PROXY=http://127.0.0.1:1080`) without
 * excluding localhost in NO_PROXY, every loopback request is routed through
 * the proxy — which may forward "127.0.0.1" to a remote node where nothing
 * is listening. Symptom: SessionStart hooks never arrive, transcripts never
 * sync, web UI stays empty.
 *
 * Fix: make sure NO_PROXY always covers loopback. Children (claude, runner,
 * hook-forwarder) inherit the patched env, so their loopback traffic is
 * covered too. Non-loopback traffic keeps using the configured proxy.
 */

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

export function ensureLoopbackProxyBypass(env: NodeJS.ProcessEnv = process.env): void {
    const existing = env.NO_PROXY ?? env.no_proxy ?? '';
    const entries = existing
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    const present = new Set(entries.map((entry) => entry.toLowerCase()));
    if (present.has('*')) {
        return;
    }

    for (const host of LOOPBACK_HOSTS) {
        if (!present.has(host)) {
            entries.push(host);
        }
    }

    const merged = entries.join(',');
    env.NO_PROXY = merged;
    env.no_proxy = merged;
}
