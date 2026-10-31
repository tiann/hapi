/**
 * Kill switch for the peer-session MCP tools (`list_peers` / `inspect_peer` /
 * `ping_peer`).
 *
 * Set `HAPI_DISABLE_PEER_TOOLS=1` in the runner environment to stop wrapped
 * agents from browsing or messaging other HAPI sessions (peer pollution):
 * the tools are not registered on the session MCP server, not advertised via
 * `--allowedTools` / `--tools`, and the peer steer block is dropped from
 * flavor system prompts. The core module refuses as defense in depth, so
 * `hapi ping-peer` / `inspect-peer` from inside a wrapped agent shell fails
 * loudly instead of silently bypassing the switch. Operators who keep the
 * variable unset in their interactive shell keep full CLI access.
 */

export const PEER_TOOL_NAMES = ['list_peers', 'ping_peer', 'inspect_peer'] as const;

export function isPeerToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return ['true', '1', 'yes'].includes((env.HAPI_DISABLE_PEER_TOOLS ?? '').toLowerCase());
}
