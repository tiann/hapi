import { beforeEach, describe, expect, it } from 'vitest'
import {
    appendTerminalExcerptToComposerDraft,
    chooseMarkdownFence,
    extractActiveBufferText,
    extractTerminalExcerpt,
    formatTerminalExcerpt,
    type TerminalTextSource,
} from './terminal-composer'
import { getDraft, saveDraft } from '@/lib/composer-drafts'

function makeTerminal(options: {
    selection?: string
    lines?: Array<string | { text: string; isWrapped?: boolean }>
}): TerminalTextSource {
    const lines = (options.lines ?? []).map((entry) =>
        typeof entry === 'string' ? { text: entry, isWrapped: false } : {
            text: entry.text,
            isWrapped: entry.isWrapped ?? false,
        }
    )
    return {
        hasSelection: () => Boolean(options.selection && options.selection.length > 0),
        getSelection: () => options.selection ?? '',
        buffer: {
            active: {
                length: lines.length,
                getLine: (index: number) => {
                    const value = lines[index]
                    if (value === undefined) return undefined
                    return {
                        isWrapped: value.isWrapped,
                        translateToString: (trimRight?: boolean) => {
                            if (trimRight === false) return value.text
                            return value.text.replace(/[ \t]+$/u, '')
                        },
                    }
                },
            },
        },
    }
}

describe('terminal-composer', () => {
    beforeEach(() => {
        window.sessionStorage.clear()
    })

    it('prefers a nonempty selection over the buffer', () => {
        const excerpt = extractTerminalExcerpt(
            makeTerminal({
                selection: 'selected line',
                lines: ['full', 'buffer'],
            })
        )
        expect(excerpt).toEqual({ kind: 'selection', text: 'selected line' })
    })

    it('falls back to the buffer when selection is whitespace-only', () => {
        const excerpt = extractTerminalExcerpt(
            makeTerminal({
                selection: '   \n',
                lines: ['hello', 'world', ''],
            })
        )
        expect(excerpt).toEqual({ kind: 'buffer', text: 'hello\nworld' })
    })

    it('returns null for an empty buffer', () => {
        expect(extractTerminalExcerpt(makeTerminal({ lines: ['', '  '] }))).toBeNull()
    })

    it('joins wrapped visual rows into one logical line and keeps wrap-boundary spaces', () => {
        const text = extractActiveBufferText(
            makeTerminal({
                lines: [
                    { text: '/work/coding/hapi/worktrees/very-long-path-name-that-wraps ' },
                    { text: 'across-columns', isWrapped: true },
                    'next command',
                ],
            }).buffer.active
        )
        expect(text).toBe(
            '/work/coding/hapi/worktrees/very-long-path-name-that-wraps across-columns\nnext command'
        )
    })

    it('formats with a longer fence when the excerpt contains backticks', () => {
        const excerpt = {
            kind: 'buffer' as const,
            text: 'cat README.md\n```md\n# hi\n```\ndone',
        }
        const fence = chooseMarkdownFence(excerpt.text)
        expect(fence).toBe('````')
        expect(formatTerminalExcerpt(excerpt)).toBe(
            `### Terminal output\n\n${fence}text\n${excerpt.text}\n${fence}`
        )
        // Outer fence must not be closable by the inner ``` run.
        expect(formatTerminalExcerpt(excerpt).includes(`\n${fence}\n`)).toBe(false)
        expect(formatTerminalExcerpt(excerpt).endsWith(`\n${fence}`)).toBe(true)
    })

    it('keeps the default three-backtick fence for ordinary text', () => {
        expect(formatTerminalExcerpt({ kind: 'selection', text: 'x' })).toBe(
            '### Terminal selection\n\n```text\nx\n```'
        )
        expect(formatTerminalExcerpt({ kind: 'buffer', text: 'y' })).toBe(
            '### Terminal output\n\n```text\ny\n```'
        )
    })

    it('appends to an existing composer draft', () => {
        saveDraft('term-composer-existing', 'please look')
        appendTerminalExcerptToComposerDraft('term-composer-existing', {
            kind: 'buffer',
            text: 'ls\nfile.txt',
        })
        expect(getDraft('term-composer-existing')).toBe(
            'please look\n\n### Terminal output\n\n```text\nls\nfile.txt\n```'
        )
    })

    it('writes a new draft when none exists', () => {
        appendTerminalExcerptToComposerDraft('term-composer-empty', {
            kind: 'selection',
            text: 'REFUSE: lane B',
        })
        expect(getDraft('term-composer-empty')).toBe(
            '### Terminal selection\n\n```text\nREFUSE: lane B\n```'
        )
    })
})
