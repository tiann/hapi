import { extractNotifySummary } from '@hapi/protocol/messages'
import type { AgentMessage } from '@/agent/types'

/**
 * #2267 — after a turn closes with `AGENT_NOTIFY_SUMMARY` `status:"done"`,
 * Cursor's finished-shell / `notify_on_output` wake injects *"Briefly inform
 * the user…"* and forces another assistant turn. Exhortation loses to that
 * system prompt; HAPI must drop the harness-resume *speech* instead.
 *
 * Scope: Cursor ACP launcher only. Clear on each new HAPI-owned `prompt()`.
 * Soft-steer still in flight counts as an active turn (Codex P2 on #307).
 */

export type PostCloseHarnessGate = {
    closedWithDone: boolean
}

export function createPostCloseHarnessGate(): PostCloseHarnessGate {
    return { closedWithDone: false }
}

/** Reset when HAPI starts a new queue-driven `session/prompt` (user or internal). */
export function clearPostCloseGateForNewUserPrompt(gate: PostCloseHarnessGate): void {
    gate.closedWithDone = false
}

/**
 * Note a settled assistant text segment. Interim `live` snapshots are ignored
 * so a partial stream that happens to end with a footer does not close early.
 */
export function noteAssistantTextForPostCloseGate(
    gate: PostCloseHarnessGate,
    text: string,
    opts?: { live?: boolean }
): void {
    if (opts?.live) return
    const summary = extractNotifySummary(text)
    if (!summary?.status) return
    gate.closedWithDone = summary.status === 'done'
}

/** HAPI-owned prompt or outstanding soft-steer still owns the turn. */
export function isPostCloseHarnessTurnActive(opts: {
    promptInFlight: boolean
    softSteerOutstanding: boolean
}): boolean {
    return opts.promptInFlight || opts.softSteerOutstanding
}

/**
 * User-visible *speech* only. Tools/plan/images stay visible so a premature
 * `done` + real follow-up work is not an invisible mutation (#2267 / cold review).
 */
const SUPPRESSED_MESSAGE_TYPES = new Set<AgentMessage['type']>([
    'text',
    'reasoning'
])

/**
 * Drop harness-resume speech after a done close, outside an active HAPI turn.
 * Errors, usage, and tool chrome still forward.
 */
export function shouldSuppressPostCloseHarnessMessage(
    gate: PostCloseHarnessGate,
    opts: {
        promptInFlight: boolean
        softSteerOutstanding?: boolean
        messageType: AgentMessage['type']
    }
): boolean {
    if (isPostCloseHarnessTurnActive({
        promptInFlight: opts.promptInFlight,
        softSteerOutstanding: opts.softSteerOutstanding === true
    })) {
        return false
    }
    if (!gate.closedWithDone) return false
    return SUPPRESSED_MESSAGE_TYPES.has(opts.messageType)
}

/** Keep the hub list idle for suppressed post-close harness speech. */
export function shouldSuppressPostCloseHarnessThinking(
    gate: PostCloseHarnessGate,
    opts: {
        promptInFlight: boolean
        softSteerOutstanding?: boolean
        thinking: boolean
    }
): boolean {
    if (!opts.thinking) return false
    if (isPostCloseHarnessTurnActive({
        promptInFlight: opts.promptInFlight,
        softSteerOutstanding: opts.softSteerOutstanding === true
    })) {
        return false
    }
    return gate.closedWithDone
}
