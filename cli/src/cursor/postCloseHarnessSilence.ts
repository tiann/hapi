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

const NOTIFY_SUMMARY_PREFIX = 'AGENT_NOTIFY_SUMMARY '

type LineFooterMatch = {
    status: string | undefined
    /** Absolute character index in the full text immediately after the footer's closing `}`. */
    endExclusive: number
}

/**
 * Closing `}` of a JSON object starting at `braceAt`, ignoring braces inside
 * quoted strings (and honoring `\` escapes).
 */
function findJsonObjectEnd(line: string, braceAt: number): number {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = braceAt; i < line.length; i += 1) {
        const ch = line[i]!
        if (inString) {
            if (escape) {
                escape = false
                continue
            }
            if (ch === '\\') {
                escape = true
                continue
            }
            if (ch === '"') inString = false
            continue
        }
        if (ch === '"') {
            inString = true
            continue
        }
        if (ch === '{') depth += 1
        else if (ch === '}') {
            depth -= 1
            if (depth === 0) return i
        }
    }
    return -1
}

/**
 * Parse a footer on one line, allowing glued trailing prose after the JSON
 * object (`...}Shell finished`). Skips whitespace-delimited mentions and
 * inline-code examples (`...`).
 */
function matchFooterOnLine(line: string, lineStartInText: number): LineFooterMatch | null {
    for (
        let idx = line.indexOf(NOTIFY_SUMMARY_PREFIX);
        idx >= 0;
        idx = line.indexOf(NOTIFY_SUMMARY_PREFIX, idx + NOTIFY_SUMMARY_PREFIX.length)
    ) {
        const prefix = line.slice(0, idx)
        if (prefix.trim().length > 0 && /\s/.test(line[idx - 1]!)) continue
        // Inline code: `AGENT_NOTIFY_SUMMARY {...}`
        if (idx > 0 && line[idx - 1] === '`') continue
        const braceAt = line.indexOf('{', idx + NOTIFY_SUMMARY_PREFIX.length)
        if (braceAt < 0) continue
        const end = findJsonObjectEnd(line, braceAt)
        if (end < 0) continue
        // Closing inline-code backtick immediately after the object.
        if (line[end + 1] === '`') continue
        try {
            const parsed: unknown = JSON.parse(line.slice(braceAt, end + 1))
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
            const status = typeof (parsed as { status?: unknown }).status === 'string'
                ? (parsed as { status: string }).status
                : undefined
            return { status, endExclusive: lineStartInText + end + 1 }
        } catch {
            // try next occurrence on the line
        }
    }
    return null
}

type FenceOpen = { char: '`' | '~'; len: number }

/** Opening/closing fence marker: ``` / ~~~ with length (≥3). */
function matchFenceMarker(line: string): FenceOpen | null {
    const trimmed = line.trim()
    const match = /^(```+|~~~+)/.exec(trimmed)
    if (!match) return null
    const token = match[1]!
    return { char: token[0] as '`' | '~', len: token.length }
}

/**
 * Last done footer outside fenced code blocks, even when trailing harness prose
 * (or same-line glue) follows. Backtick and tilde fences (matching opener
 * length) are ignored so documentation turns are not treated as a real close
 * (#2268 Minor).
 */
function findLastUnfencedDoneFooterEnd(text: string): number | null {
    const lines = text.split('\n')
    let openFence: FenceOpen | null = null
    let offset = 0
    let lastDoneEnd: number | null = null

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!
        const fence = matchFenceMarker(line)
        if (fence) {
            if (!openFence) {
                openFence = fence
            } else if (openFence.char === fence.char && fence.len >= openFence.len) {
                openFence = null
            }
        } else if (!openFence) {
            const match = matchFooterOnLine(line, offset)
            if (match?.status === 'done') {
                lastDoneEnd = match.endExclusive
            } else if (match?.status) {
                // A later non-done footer supersedes a prior done close.
                lastDoneEnd = null
            }
        }
        offset += line.length
        if (i < lines.length - 1) offset += 1 // newline
    }
    return lastDoneEnd
}

/**
 * When a done footer (outside fences) is buried under coalesced harness prose,
 * return text through that footer. Soft-steer turns skip truncation so
 * user-owned steered speech is preserved (#2268 Minors).
 */
export function truncateCoalescedHarnessAfterDoneFooter(
    text: string,
    opts?: { softSteerOutstanding?: boolean }
): string | null {
    if (!text) return null
    if (opts?.softSteerOutstanding === true) return null
    const end = findLastUnfencedDoneFooterEnd(text)
    if (end === null) return null
    if (end >= text.length) return null
    if (text.slice(end).trim() === '') return null
    return text.slice(0, end)
}

/**
 * Note a settled assistant text segment. Interim `live` snapshots are ignored
 * so a partial stream that happens to end with a footer does not close early.
 * End-anchored only — buried/example markers are handled at the Cursor seal
 * boundary / truncate path, not by weakening the shared footer contract.
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
