import { getDraft, saveDraft } from '@/lib/composer-drafts'

/** Minimal xterm surface needed to extract plain text for the composer. */
export type TerminalTextSource = {
    hasSelection: () => boolean
    getSelection: () => string
    buffer: {
        active: {
            length: number
            getLine: (index: number) => {
                isWrapped: boolean
                translateToString: (trimRight?: boolean) => string
            } | undefined
        }
    }
}

export type TerminalExcerptKind = 'selection' | 'buffer'

export type TerminalExcerpt = {
    kind: TerminalExcerptKind
    text: string
}

type BufferLine = {
    isWrapped: boolean
    translateToString: (trimRight?: boolean) => string
}

/**
 * Collapse xterm visual rows into logical lines.
 *
 * When output wraps, continuation rows have `isWrapped`. Inserting a newline
 * between those rows would split paths/commands/JSON. Trailing spaces at a
 * wrap boundary are kept so identifiers are not glued together wrong.
 */
export function extractActiveBufferText(buffer: {
    length: number
    getLine: (index: number) => BufferLine | undefined
}): string {
    const logical: string[] = []
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i)
        if (!line) continue
        const next = buffer.getLine(i + 1)
        const nextContinues = Boolean(next?.isWrapped)
        // Keep trailing spaces when the next visual row continues this line.
        const text = line.translateToString(!nextContinues)
        if (line.isWrapped && logical.length > 0) {
            logical[logical.length - 1] += text
        } else {
            logical.push(text)
        }
    }

    while (logical.length > 0 && logical[logical.length - 1]!.trim().length === 0) {
        logical.pop()
    }
    return logical.join('\n')
}

/** Prefer a nonempty selection; otherwise the active buffer including scrollback. */
export function extractTerminalExcerpt(terminal: TerminalTextSource): TerminalExcerpt | null {
    if (terminal.hasSelection()) {
        const selection = terminal.getSelection().replace(/\s+$/u, '')
        if (selection.trim().length > 0) {
            return { kind: 'selection', text: selection }
        }
    }

    const text = extractActiveBufferText(terminal.buffer.active)
    if (text.trim().length === 0) {
        return null
    }
    return { kind: 'buffer', text }
}

/** Fence longer than any backtick run in the body so terminal Markdown cannot close it. */
export function chooseMarkdownFence(text: string): string {
    const runs = text.match(/`+/gu) ?? []
    let longest = 0
    for (const run of runs) {
        longest = Math.max(longest, run.length)
    }
    return '`'.repeat(Math.max(3, longest + 1))
}

export function formatTerminalExcerpt(excerpt: TerminalExcerpt): string {
    const label = excerpt.kind === 'selection' ? 'Terminal selection' : 'Terminal output'
    const fence = chooseMarkdownFence(excerpt.text)
    return `### ${label}\n\n${fence}text\n${excerpt.text}\n${fence}`
}

/**
 * Append a terminal excerpt to a session's composer draft.
 *
 * The composer is unmounted on the terminal route, so callers persist here and
 * navigate back to chat; `useComposerDraft` restores the draft on mount.
 */
export function appendTerminalExcerptToComposerDraft(sessionId: string, excerpt: TerminalExcerpt): void {
    const block = formatTerminalExcerpt(excerpt)
    const existing = getDraft(sessionId).replace(/[ \t\r\n]+$/u, '')
    saveDraft(sessionId, existing.length > 0 ? `${existing}\n\n${block}` : block)
}
