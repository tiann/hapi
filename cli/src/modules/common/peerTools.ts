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

/**
 * Env overlay resolving the kill switch for one session's captured preference.
 *
 * Used in two places that cannot read the module memory:
 * - wrapped-agent child environments (claude/opencode/ACP spawn env, Codex
 *   per-root `shell_environment_policy.set`): an agent shelling out
 *   `hapi ping-peer` starts a fresh process where `hubPreference` is lost, so
 *   the resolved preference must travel as an explicit env value;
 * - call-time prompt resolution inside one runner process hosting sessions
 *   with different captured preferences (a flipped global must not rewrite a
 *   live session's prompt), so both branches pin an explicit value.
 *
 * A non-empty machine-level `HAPI_DISABLE_PEER_TOOLS` stays authoritative
 * (deploy-time override inherits naturally into children). The operator
 * terminal never passes through a wrapped-agent spawn, so its exemption is
 * untouched.
 */
export function peerToolsEnvOverlay(disabled: boolean, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const raw = env.HAPI_DISABLE_PEER_TOOLS
    if (raw !== undefined && raw !== '') return {}
    return { HAPI_DISABLE_PEER_TOOLS: disabled ? '1' : '0' }
}

/** Env for prompt/child resolution after applying the session overlay. */
export function withPeerToolsPreference(disabled: boolean, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return { ...env, ...peerToolsEnvOverlay(disabled, env) }
}

/**
 * Resolve a session's create-time hub preference into the effective state,
 * honoring the machine-level deploy override: a non-empty
 * `HAPI_DISABLE_PEER_TOOLS` beats the hub value in both directions, otherwise
 * the hub value stands. ApiSessionClient captures snapshots through this so
 * every consumer (`client.peerToolsDisabled ?? isPeerToolsDisabled()`) reads
 * an already-env-resolved truth instead of the raw hub boolean.
 */
export function resolveSessionPeerToolsDisabled(hubDisabled: boolean): boolean {
    return isPeerToolsDisabled(withPeerToolsPreference(hubDisabled))
}
