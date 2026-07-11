import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    isRequestUserInputQuestionAnswered,
    openRequestUserInputUrl,
    parseRequestUserInputInput
} from './requestUserInput'

describe('MCP URL request user input', () => {
    afterEach(() => vi.restoreAllMocks())

    it('only exposes http(s) URLs to the approval UI', () => {
        expect(parseRequestUserInputInput({ url: 'https://example.com/login', questions: [] }).url)
            .toBe('https://example.com/login')
        expect(parseRequestUserInputInput({ url: 'javascript:alert(1)', questions: [] }).url)
            .toBeNull()
    })

    it('reports popup failures instead of treating the URL as opened', () => {
        const open = vi.spyOn(window, 'open').mockReturnValue(null)
        expect(openRequestUserInputUrl('https://example.com/login')).toBe(false)
        expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    })

    it('severs opener access before navigating to an external MCP URL', () => {
        const replace = vi.fn()
        const popup = {
            opener: window,
            location: { replace }
        } as unknown as Window
        const open = vi.spyOn(window, 'open').mockReturnValue(popup)

        expect(openRequestUserInputUrl('https://example.com/login')).toBe(true)
        expect(open).toHaveBeenCalledWith('about:blank', '_blank')
        expect(popup.opener).toBeNull()
        expect(replace).toHaveBeenCalledWith('https://example.com/login')
    })

    it('preserves optional form questions and allows them to stay empty', () => {
        const parsed = parseRequestUserInputInput({
            questions: [{ id: 'comment', question: 'Comment', required: false, options: [] }]
        })

        expect(parsed.questions[0]).toEqual({
            id: 'comment',
            question: 'Comment',
            required: false,
            options: []
        })
        expect(isRequestUserInputQuestionAnswered(parsed.questions[0]!, {
            selected: null,
            userNote: ''
        })).toBe(true)
    })
})
