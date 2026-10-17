/**
 * Kill switch for the peer-session MCP tools (`list_peers` / `inspect_peer` /
 * `ping_peer`).
 *
 * Wrapped agents with these tools can browse the session list and message
 * other sessions, polluting peer contexts on busy runners. When the switch is
 * on, the tools are not registered on the session MCP server, not advertised
 * via `--allowedTools` / `--tools`, and the peer steer block is dropped from
 * flavor system prompts. The core module refuses as defense in depth, so
 * `hapi ping-peer` / `inspect-peer` from inside a wrapped agent shell fails
 * loudly instead of silently bypassing the switch. Operators who keep the
 * switch off in their interactive terminal keep full CLI access.
 *
 * Resolution order (mirrors sessionSummaryContract):
 * 1. Explicit HAPI_DISABLE_PEER_TOOLS env (0|false|off|no → off; anything else → on)
 * 2. Hub preference applied via `applyHubPeerToolsDisabled` (from session bootstrap)
 * 3. Default: off (tools available)
 */

export const PEER_TOOL_NAMES = ['list_peers', 'ping_peer', 'inspect_peer'] as const;

let hubPreference: boolean | undefined

/** Apply the hub-resolved toggle from session create/get bootstrap. */
export function applyHubPeerToolsDisabled(disabled: boolean): void {
    hubPreference = disabled
}

/** Test-only: clear hub preference between cases. */
export function resetPeerToolsForTests(): void {
    hubPreference = undefined
}

export function isPeerToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.HAPI_DISABLE_PEER_TOOLS
    if (raw !== undefined && raw !== '') {
        const normalized = raw.trim().toLowerCase()
        return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
    }
    return hubPreference === true
}
