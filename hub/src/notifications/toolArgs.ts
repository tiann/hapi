/**
 * Tool argument formatters shared across notification channels.
 *
 * Originally lived inside hub/src/telegram/sessionView.ts. Lifted into
 * notifications/ so the FCM (Wear OS) channel can reuse the same
 * tool-aware extraction without forking the switch table - keeping
 * Telegram and Wear notifications in sync as we add tools.
 *
 * Two surfaces are exposed:
 *
 * - `formatToolArgumentsDetailed`  - multi-line, Telegram-grade detail.
 *   Renders inside Telegram bot messages where vertical space is cheap.
 *   Also rendered by Wear OS when the operator taps the notification
 *   to expand (BigTextStyle).
 *
 * - `formatToolArgumentsCompact`   - single-line, glance-friendly.
 *   Squeezed into the wrist's collapsed notification line (~40 chars
 *   before truncation). The detailed form is the source of truth; the
 *   compact form is a deliberately-brutal summary of just enough to
 *   know which file/cmd/url is at stake.
 */

const DEFAULT_DETAIL_MAX_ARG_LENGTH = 150

function truncate(text: string, maxLen: number): string {
    if (!text) return ''
    if (text.length <= maxLen) return text
    return text.slice(0, Math.max(0, maxLen - 3)) + '...'
}

function shortPath(file: string): string {
    if (!file) return ''
    const segs = file.split('/')
    if (segs.length <= 2) return file
    return `.../${segs.slice(-2).join('/')}`
}

export function formatToolArgumentsDetailed(
    tool: string,
    args: unknown,
    opts: { maxArgLength?: number } = {}
): string {
    if (!args || typeof args !== 'object') return ''
    const maxLen = opts.maxArgLength ?? DEFAULT_DETAIL_MAX_ARG_LENGTH
    const a = args as Record<string, unknown>

    try {
        switch (tool) {
            case 'Edit': {
                const file = (a.file_path as string | undefined) ?? (a.path as string | undefined) ?? 'unknown'
                const oldStr = a.old_string ? truncate(String(a.old_string), 50) : ''
                const newStr = a.new_string ? truncate(String(a.new_string), 50) : ''
                let result = `File: ${truncate(file, maxLen)}`
                if (oldStr) result += `\nOld: "${oldStr}"`
                if (newStr) result += `\nNew: "${newStr}"`
                return result
            }
            case 'Write': {
                const file = (a.file_path as string | undefined) ?? (a.path as string | undefined) ?? 'unknown'
                const content = a.content ? `${String(a.content).length} chars` : ''
                return `File: ${truncate(file, maxLen)}${content ? ` (${content})` : ''}`
            }
            case 'Read': {
                const file = (a.file_path as string | undefined) ?? (a.path as string | undefined) ?? 'unknown'
                return `File: ${truncate(file, maxLen)}`
            }
            case 'Bash': {
                const cmd = (a.command as string | undefined) ?? ''
                return `Command: ${truncate(cmd, maxLen)}`
            }
            case 'Agent':
            case 'Task': {
                const desc = (a.description as string | undefined) ?? (a.prompt as string | undefined) ?? ''
                return `Task: ${truncate(desc, maxLen)}`
            }
            case 'Grep':
            case 'Glob': {
                const pattern = (a.pattern as string | undefined) ?? ''
                const path = (a.path as string | undefined) ?? ''
                let result = `Pattern: ${truncate(pattern, maxLen)}`
                if (path) result += `\nPath: ${truncate(path, 80)}`
                return result
            }
            case 'WebFetch': {
                const url = (a.url as string | undefined) ?? ''
                return `URL: ${truncate(url, maxLen)}`
            }
            case 'TodoWrite': {
                const todos = a.todos as unknown[] | undefined
                const count = todos?.length ?? 0
                return `Updating ${count} todo items`
            }
            default: {
                const argStr = JSON.stringify(args)
                if (argStr && argStr.length > 10) {
                    return `Args: ${truncate(argStr, maxLen)}`
                }
                return ''
            }
        }
    } catch {
        return ''
    }
}

/**
 * Single-line summary tuned for the Wear OS collapsed notification line
 * (~40 chars displayable before the system truncates). Always returns
 * a one-liner with no embedded newlines. Empty string means we have no
 * useful summary to show beyond the tool name itself.
 */
export function formatToolArgumentsCompact(tool: string, args: unknown): string {
    if (!args || typeof args !== 'object') return ''
    const a = args as Record<string, unknown>

    try {
        switch (tool) {
            case 'Edit':
            case 'Write':
            case 'Read': {
                const file = (a.file_path as string | undefined) ?? (a.path as string | undefined)
                if (!file) return ''
                return shortPath(file)
            }
            case 'Bash': {
                const cmd = (a.command as string | undefined) ?? ''
                return truncate(cmd, 60)
            }
            case 'Agent':
            case 'Task': {
                const desc = (a.description as string | undefined) ?? (a.prompt as string | undefined) ?? ''
                return truncate(desc, 60)
            }
            case 'Grep':
            case 'Glob': {
                const pattern = (a.pattern as string | undefined) ?? ''
                return truncate(pattern, 60)
            }
            case 'WebFetch': {
                const url = (a.url as string | undefined) ?? ''
                try {
                    if (url) return new URL(url).host
                } catch { /* fall through */ }
                return truncate(url, 60)
            }
            case 'TodoWrite': {
                const todos = a.todos as unknown[] | undefined
                const count = todos?.length ?? 0
                return `${count} items`
            }
            default:
                return ''
        }
    } catch {
        return ''
    }
}
