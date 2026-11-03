import { extractNotifySummary } from '@hapi/protocol/messages'
import type { AgentMessage } from '@/agent/types'

/**
 * #2267 — after a turn closes with `AGENT_NOTIFY_SUMMARY` `status:"done"`,
 * Cursor's finished-shell / `notify_on_output` wake injects *"Briefly inform
 * the user…"* and forces another assistant turn. Exhortation loses to that
 * system prompt; HAPI must drop the harness-resume *speech* instead.
 *
 * Scope: Cursor ACP launcher only. Soft-steer still in flight stays exempt.
 * Once `closedWithDone`, speech stays suppressed through prompt() drain windows
 * until the next prompt's handler swap reopens the gate (upstream bot Minors).
 */

export type PostCloseHarnessGate = {
    closedWithDone: boolean
}

export function createPostCloseHarnessGate(): PostCloseHarnessGate {
    return { closedWithDone: false }
}

/** Reset when the next HAPI prompt's message handler is installed (post-swap). */
export function clearPostCloseGateForNewUserPrompt(gate: PostCloseHarnessGate): void {
    gate.closedWithDone = false
}

/**
 * Last well-formed `AGENT_NOTIFY_SUMMARY` in `text`, even when trailing harness
 * prose follows. Shared `extractNotifySummary` is end-anchored; the quiet-drain
 * coalescing window can bury the done footer under finished-shell speech.
 */
export function extractLastNotifySummaryAllowingTrailing(text: string): ReturnType<typeof extractNotifySummary> {
    if (!text) return null
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]!.trim() === '') continue
        const candidate = lines.slice(0, i + 1).join('\n')
        const summary = extractNotifySummary(candidate)
        if (summary) return summary
    }
    return null
}

/**
 * When a done footer is buried under coalesced harness prose, return text
 * through that footer so the launcher can forward the real close without the
 * redundant resume. `null` means no truncation needed.
 */
export function truncateCoalescedHarnessAfterDoneFooter(text: string): string | null {
    if (!text) return null
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i]!.trim() === '') continue
        const candidate = lines.slice(0, i + 1).join('\n')
        const summary = extractNotifySummary(candidate)
        if (!summary?.status) continue
        if (summary.status !== 'done') return null
        const trailing = lines.slice(i + 1).join('\n')
        if (trailing.trim() === '') return null
        return candidate
    }
    return null
}

/**
 * Note a settled assistant text segment. Interim `live` snapshots are ignored
 * so a partial stream that happens to end with a footer does not close early.
 * Accepts a done footer buried under trailing harness prose (#2268 Minor).
 */
export function noteAssistantTextForPostCloseGate(
    gate: PostCloseHarnessGate,
    text: string,
    opts?: { live?: boolean }
): void {
    if (opts?.live) return
    const summary = extractLastNotifySummaryAllowingTrailing(text)
    if (!summary?.status) return
    gate.closedWithDone = summary.status === 'done'
}

/**
 * User-visible *speech* only. Tools/plan/images stay visible so a premature
 * `done` + real follow-up work is not an invisible mutation.
 */
const SUPPRESSED_MESSAGE_TYPES = new Set<AgentMessage['type']>([
    'text',
    'reasoning'
])

/**
 * Drop harness-resume speech after a done close. Soft-steer still outstanding
 * stays exempt. `promptInFlight` does **not** reopen speech — drain windows
 * after the native response still count as post-close (#2267 bot Minor).
 */
export function shouldSuppressPostCloseHarnessMessage(
    gate: PostCloseHarnessGate,
    opts: {
        promptInFlight?: boolean
        softSteerOutstanding?: boolean
        messageType: AgentMessage['type']
    }
): boolean {
    if (opts.softSteerOutstanding === true) return false
    if (!gate.closedWithDone) return false
    return SUPPRESSED_MESSAGE_TYPES.has(opts.messageType)
}

/** Keep the hub list idle for suppressed post-close harness speech. */
export function shouldSuppressPostCloseHarnessThinking(
    gate: PostCloseHarnessGate,
    opts: {
        promptInFlight?: boolean
        softSteerOutstanding?: boolean
        thinking: boolean
    }
): boolean {
    if (!opts.thinking) return false
    if (opts.softSteerOutstanding === true) return false
    return gate.closedWithDone
}

/** @deprecated Prefer soft-steer exemption + generation-gated clear. */
export function isPostCloseHarnessTurnActive(opts: {
    promptInFlight: boolean
    softSteerOutstanding: boolean
}): boolean {
    return opts.promptInFlight || opts.softSteerOutstanding
}
