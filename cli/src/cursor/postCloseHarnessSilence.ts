import { extractNotifySummary } from '@hapi/protocol/messages'
import type { AgentMessage } from '@/agent/types'

/**
 * #2267 — after a turn closes with `AGENT_NOTIFY_SUMMARY` `status:"done"`,
 * Cursor's finished-shell / `notify_on_output` wake injects *"Briefly inform
 * the user…"* and forces another assistant turn. Exhortation loses to that
 * system prompt; HAPI must drop the harness-resume chrome instead.
 *
 * Scope: Cursor ACP launcher only. Clear on each new HAPI-owned `prompt()`.
 */

export type PostCloseHarnessGate = {
    closedWithDone: boolean
}

export function createPostCloseHarnessGate(): PostCloseHarnessGate {
    return { closedWithDone: false }
}

/** Reset when HAPI starts a new user-driven `session/prompt`. */
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

const SUPPRESSED_MESSAGE_TYPES = new Set<AgentMessage['type']>([
    'text',
    'reasoning',
    'tool_call',
    'tool_result',
    'generated_image',
    'plan'
])

/**
 * Drop user-visible harness-resume traffic after a done close, outside a
 * HAPI-owned prompt. Errors and usage still forward.
 */
export function shouldSuppressPostCloseHarnessMessage(
    gate: PostCloseHarnessGate,
    opts: { promptInFlight: boolean; messageType: AgentMessage['type'] }
): boolean {
    if (opts.promptInFlight || !gate.closedWithDone) return false
    return SUPPRESSED_MESSAGE_TYPES.has(opts.messageType)
}

/** Keep the hub list idle for suppressed post-close harness resumes. */
export function shouldSuppressPostCloseHarnessThinking(
    gate: PostCloseHarnessGate,
    opts: { promptInFlight: boolean; thinking: boolean }
): boolean {
    return Boolean(opts.thinking && !opts.promptInFlight && gate.closedWithDone)
}
