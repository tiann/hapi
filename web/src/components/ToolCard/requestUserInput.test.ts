import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    isRequestUserInputQuestionAnswered,
    isRequestUserInputUrlConfirmed,
    formatRequestUserInputAnswers,
    openRequestUserInputUrl,
    parseRequestUserInputAnswers,
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
            multiple: false,
            options: []
        })
        expect(isRequestUserInputQuestionAnswered(parsed.questions[0]!, {
            selected: [],
            userNote: ''
        })).toBe(true)
    })

    it('preserves Pi extension textarea placeholder, prefill, and editor type', () => {
        const parsed = parseRequestUserInputInput({
            questions: [{
                id: 'comment',
                question: 'Comment',
                options: [],
                placeholder: 'Describe the change',
                prefill: 'Initial draft',
                inputType: 'editor'
            }]
        })

        expect(parsed.questions[0]).toMatchObject({
            id: 'comment',
            placeholder: 'Describe the change',
            prefill: 'Initial draft',
            inputType: 'editor'
        })
    })

    it('round-trips editor whitespace and an intentionally empty document', () => {
        const question = parseRequestUserInputInput({
            questions: [{ id: 'document', question: 'Document', required: true, options: [], inputType: 'editor' }]
        }).questions[0]!

        expect(isRequestUserInputQuestionAnswered(question, { selected: [], userNote: '' })).toBe(true)
        const whitespaceAnswers = formatRequestUserInputAnswers({
            document: { selected: [], userNote: '  code\n' }
        }, [question])
        expect(whitespaceAnswers).toEqual({
            answers: { document: { answers: ['user_note:   code\n'] } }
        })
        expect(parseRequestUserInputAnswers(whitespaceAnswers, [question])).toEqual({
            document: { selected: [], userNote: '  code\n' }
        })

        const emptyAnswers = formatRequestUserInputAnswers({
            document: { selected: [], userNote: '' }
        }, [question])
        expect(emptyAnswers).toEqual({
            answers: { document: { answers: ['user_note: '] } }
        })
        expect(parseRequestUserInputAnswers(emptyAnswers, [question])).toEqual({
            document: { selected: [], userNote: '' }
        })
    })

    it('parses an option beginning with user_note as a selection before metadata', () => {
        const question = parseRequestUserInputInput({
            questions: [{
                id: 'choice', question: 'Choose', options: [{ label: 'user_note: later' }]
            }]
        }).questions[0]!

        expect(parseRequestUserInputAnswers({
            choice: { answers: ['user_note: later'] }
        }, [question])).toEqual({
            choice: { selected: ['user_note: later'], userNote: null }
        })
    })

    it('requires an actual selection for required choice questions', () => {
        const question = parseRequestUserInputInput({
            questions: [{
                id: 'approved',
                question: 'Approved?',
                required: true,
                options: [{ label: 'true', description: '' }, { label: 'false', description: '' }]
            }]
        }).questions[0]!

        expect(isRequestUserInputQuestionAnswered(question, {
            selected: [],
            userNote: 'please approve'
        })).toBe(false)
        expect(isRequestUserInputQuestionAnswered(question, {
            selected: ['true'],
            userNote: 'please approve'
        })).toBe(true)
    })

    it('opens an MCP URL only after selecting its explicit confirmation option', () => {
        const url = 'https://example.com/login'
        const hidden = parseRequestUserInputInput({
            url,
            questions: [{ id: 'unrelated', question: 'Continue?', options: [] }]
        })
        expect(isRequestUserInputUrlConfirmed(hidden, {
            unrelated: { selected: [], userNote: 'yes' }
        })).toBe(false)

        const explicit = parseRequestUserInputInput({
            url,
            questions: [{
                id: '__mcp_url_confirmation',
                question: 'Sign in',
                options: [{ label: 'Open', description: url }]
            }]
        })
        expect(isRequestUserInputUrlConfirmed(explicit, {
            __mcp_url_confirmation: { selected: [], userNote: '' }
        })).toBe(false)
        expect(isRequestUserInputUrlConfirmed(explicit, {
            __mcp_url_confirmation: { selected: ['Open'], userNote: '' }
        })).toBe(true)
    })

    it('serializes every selected value for multiple-choice questions', () => {
        const parsed = parseRequestUserInputInput({
            questions: [{
                id: 'tags',
                question: 'Tags',
                required: true,
                multiple: true,
                options: [{ label: 'bug' }, { label: 'feature' }]
            }]
        })

        expect(parsed.questions[0]?.multiple).toBe(true)
        expect(formatRequestUserInputAnswers({
            tags: { selected: ['bug', 'feature'], userNote: '' }
        })).toEqual({
            answers: { tags: { answers: ['bug', 'feature'] } }
        })
    })
})
