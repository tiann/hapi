import { describe, expect, it } from 'vitest'
import {
    AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD,
    buildTextContextFilename,
    createTextContextFile,
    getCollapsedUserMessage,
    insertTextAtSelection,
    shouldConvertPastedTextToContext,
} from './textContext'

describe('text context rules', () => {
    it('converts pasted text at 3000 characters', () => {
        expect(shouldConvertPastedTextToContext(
            'x'.repeat(AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD - 1),
        )).toBe(false)
        expect(shouldConvertPastedTextToContext(
            'x'.repeat(AUTO_TEXT_CONTEXT_CHARACTER_THRESHOLD),
        )).toBe(true)
    })

    it('converts pasted text only after it exceeds 60 lines', () => {
        expect(shouldConvertPastedTextToContext(
            Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n'),
        )).toBe(false)
        expect(shouldConvertPastedTextToContext(
            Array.from({ length: 61 }, (_, index) => `line ${index}`).join('\n'),
        )).toBe(true)
    })

    it('supports custom character and line thresholds', () => {
        expect(shouldConvertPastedTextToContext('x'.repeat(2_000), {
            characterThreshold: 2_000,
            lineThreshold: 100,
        })).toBe(true)
        expect(shouldConvertPastedTextToContext(
            Array.from({ length: 21 }, (_, index) => `line ${index}`).join('\n'),
            {
                characterThreshold: 10_000,
                lineThreshold: 20,
            },
        )).toBe(true)
    })

    it('collapses user messages after 15 lines', () => {
        const text = Array.from({ length: 16 }, (_, index) => `line ${index + 1}`).join('\n')
        const result = getCollapsedUserMessage(text)

        expect(result.collapsible).toBe(true)
        expect(result.preview).toContain('line 15')
        expect(result.preview).not.toContain('line 16')
    })

    it('restores a failed context paste at the current selection', () => {
        expect(insertTextAtSelection(
            'before after',
            { start: 7, end: 7 },
            'context ',
        )).toEqual({
            text: 'before context after',
            selection: { start: 15, end: 15 },
        })
    })

    it('builds safe text filenames and UTF-8 files', () => {
        const now = new Date(2026, 7, 31, 15, 30, 5).getTime()
        expect(buildTextContextFilename('', now)).toBe('context-20260831-153005.txt')
        expect(buildTextContextFilename(' API: old/design ')).toBe('API- old-design.txt')

        const file = createTextContextFile('上下文', '需求背景', now)
        expect(file.name).toBe('需求背景.txt')
        expect(file.type).toBe('text/plain;charset=utf-8')
        expect(file.size).toBe(new Blob(['上下文']).size)
    })
})
