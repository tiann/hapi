import { describe, expect, test } from 'bun:test'
import { AGENT_MESSAGE_PAYLOAD_TYPE } from './modes'
import {
    extractAssistantPlainText,
    extractNotifySummary,
    isAssistantTextMessage,
    getLiveReasoningStreamId,
    getReasoningStreamId,
    isRedundantGoalStatusEventContent,
    splitNotifySummary,
    stripNotifySummaryFooter,
    type NotifySummary
} from './messages'

describe('extractAssistantPlainText', () => {
    test('returns null for non-objects', () => {
        expect(extractAssistantPlainText(null)).toBeNull()
        expect(extractAssistantPlainText(undefined)).toBeNull()
        expect(extractAssistantPlainText('string')).toBeNull()
        expect(extractAssistantPlainText(42)).toBeNull()
    })

    test('extracts codex/message text', () => {
        const content = {
            type: 'codex',
            data: {
                type: 'message',
                message: 'Hello there.'
            }
        }
        expect(extractAssistantPlainText(content)).toBe('Hello there.')
    })

    test('extracts event/message text', () => {
        const content = {
            type: 'event',
            data: {
                type: 'message',
                message: 'Visible event reply.'
            }
        }
        expect(extractAssistantPlainText(content)).toBe('Visible event reply.')
    })

    test('returns null for codex/tool-call (no text)', () => {
        const content = {
            type: 'codex',
            data: {
                type: 'tool-call',
                name: 'Edit',
                callId: 'x',
                input: {}
            }
        }
        expect(extractAssistantPlainText(content)).toBeNull()
    })

    test('returns null for codex/tool-call-result (no text)', () => {
        const content = {
            type: 'codex',
            data: {
                type: 'tool-call-result',
                output: {}
            }
        }
        expect(extractAssistantPlainText(content)).toBeNull()
    })

    test('returns null when codex/message string is empty', () => {
        const content = { type: 'codex', data: { type: 'message', message: '' } }
        expect(extractAssistantPlainText(content)).toBeNull()
    })

    test('extracts output/assistant text from claude SDK content array', () => {
        const content = {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Line one.' },
                        { type: 'tool_use', name: 'Edit' },
                        { type: 'text', text: 'Line two.' }
                    ]
                }
            }
        }
        expect(extractAssistantPlainText(content)).toBe('Line one.\nLine two.')
    })

    test('returns null for output/assistant with no text blocks', () => {
        const content = {
            type: 'output',
            data: {
                type: 'assistant',
                message: { content: [{ type: 'tool_use', name: 'Edit' }] }
            }
        }
        expect(extractAssistantPlainText(content)).toBeNull()
    })

    test('returns null for output/user (not assistant)', () => {
        const content = { type: 'output', data: { type: 'user', message: { content: [] } } }
        expect(extractAssistantPlainText(content)).toBeNull()
    })

    test('extracts AGY agy_message prose', () => {
        const content = {
            type: 'output',
            data: { type: 'agy_message', content: 'PINGOK\n\nAGENT_NOTIFY_SUMMARY {"status":"done","summary":"ok"}' }
        }
        expect(extractAssistantPlainText(content)).toContain('AGENT_NOTIFY_SUMMARY')
    })

    test('returns null for empty AGY agy_message', () => {
        expect(extractAssistantPlainText({
            type: 'output',
            data: { type: 'agy_message', content: '   ' }
        })).toBeNull()
    })

    test('returns null for unknown content shapes', () => {
        expect(extractAssistantPlainText({ type: 'event', data: {} })).toBeNull()
        expect(extractAssistantPlainText({ type: 'text' })).toBeNull()
    })
})

describe('isAssistantTextMessage', () => {
    test('accepts a visible assistant message and rejects non-text agent events', () => {
        expect(isAssistantTextMessage({
            role: 'agent',
            content: { type: 'codex', data: { type: 'message', message: 'answer' } }
        })).toBe(true)
        expect(isAssistantTextMessage({
            role: 'agent',
            content: { type: 'codex', data: { type: 'tool-call', name: 'Edit' } }
        })).toBe(false)
        expect(isAssistantTextMessage({
            role: 'user',
            content: { type: 'codex', data: { type: 'message', message: 'not an assistant reply' } }
        })).toBe(false)
        expect(isAssistantTextMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isMeta: true,
                    message: { content: [{ type: 'text', text: 'hidden recap' }] }
                }
            }
        })).toBe(false)
    })

    test('rejects a role-wrapped event/message status notice', () => {
        expect(isAssistantTextMessage({
            role: 'agent',
            content: {
                type: 'event',
                data: { type: 'message', message: 'Visible event reply.' }
            }
        })).toBe(false)
    })

    test('rejects sidechain assistant prose', () => {
        expect(isAssistantTextMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'subagent progress' }] }
                }
            }
        })).toBe(false)
    })

    test('rejects hidden notification and AGY tool-only output', () => {
        const footer = 'AGENT_NOTIFY_SUMMARY {"status":"done","summary":"ok"}'
        expect(isAssistantTextMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: footer } }
        })).toBe(false)
        expect(isAssistantTextMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: `Visible answer\n${footer}` } }
        })).toBe(true)
        expect(isAssistantTextMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'agy_message', content: 'Inside the task-266 log\n[Message] result' }
            }
        })).toBe(false)
    })
})

describe('extractNotifySummary', () => {
    const FULL_LINE = 'AGENT_NOTIFY_SUMMARY {"version":1,"agent":"hapi-monitor agent","project":"hapi-monitor","status":"done","action":"Revoke tokens","summary":"Published v0.1.0"}'

    test('returns null on non-string input', () => {
        expect(extractNotifySummary(null)).toBeNull()
        expect(extractNotifySummary(undefined)).toBeNull()
        expect(extractNotifySummary({})).toBeNull()
        expect(extractNotifySummary(42)).toBeNull()
        expect(extractNotifySummary('')).toBeNull()
    })

    test('parses a summary on its own line at the very end', () => {
        const result = extractNotifySummary(FULL_LINE)
        expect(result).not.toBeNull()
        const r = result as NotifySummary
        expect(r.version).toBe(1)
        expect(r.agent).toBe('hapi-monitor agent')
        expect(r.project).toBe('hapi-monitor')
        expect(r.status).toBe('done')
        expect(r.action).toBe('Revoke tokens')
        expect(r.summary).toBe('Published v0.1.0')
    })

    test('parses summary as last non-empty line after preceding prose', () => {
        const text = `Here is what I did.\n\nThings worked.\n\n${FULL_LINE}`
        const r = extractNotifySummary(text)
        expect(r?.summary).toBe('Published v0.1.0')
    })

    test('parses when prose is glued onto the same last line before the token', () => {
        // Agents sometimes omit the newline before the footer.
        const glued = 'Ownership session pinged.AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"ok"}'
        const r = extractNotifySummary(glued)
        expect(r).not.toBeNull()
        expect(r?.version).toBe(1)
        expect(r?.status).toBe('done')
        expect(r?.summary).toBe('ok')
    })

    test('rejects whitespace-delimited contract examples on the last line', () => {
        const example = 'Example: AGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}'
        expect(extractNotifySummary(example)).toBeNull()
        expect(splitNotifySummary(example)).toBeNull()
        expect(stripNotifySummaryFooter(example)).toBe(example)
    })

    test('accepts a standalone footer with leading indentation', () => {
        const indented = '    AGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}'
        const r = extractNotifySummary(indented)
        expect(r?.summary).toBe('Done')
        expect(r?.status).toBe('done')
        expect(stripNotifySummaryFooter(`Prose.\n${indented}`)).toBe('Prose.')
    })

    test('parses glued token after multi-line prose (token still on last line)', () => {
        const text = `Did the work.\n\nOwnership session pinged.AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"ok"}`
        const r = extractNotifySummary(text)
        expect(r?.summary).toBe('ok')
        expect(r?.status).toBe('done')
    })

    test('tolerates trailing whitespace and blank lines', () => {
        const r = extractNotifySummary(`prose\n\n${FULL_LINE}\n\n  \n`)
        expect(r?.summary).toBe('Published v0.1.0')
    })

    test('returns null when summary is not on the LAST non-empty line', () => {
        // Operator wrote prose AFTER the line - non-compliant.
        const text = `${FULL_LINE}\nOh, one more thing.`
        expect(extractNotifySummary(text)).toBeNull()
    })

    test('ignores mid-message token that is not on the last non-empty line', () => {
        const text = [
            'See AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"mid"} for the contract.',
            'More prose after that quote.',
        ].join('\n')
        expect(extractNotifySummary(text)).toBeNull()
    })

    test('returns null when prefix is missing', () => {
        expect(extractNotifySummary('NOTIFY_SUMMARY {"summary":"x"}')).toBeNull()
        expect(extractNotifySummary('agent_notify_summary {"summary":"x"}')).toBeNull()
    })

    test('returns null when JSON is malformed', () => {
        expect(extractNotifySummary('AGENT_NOTIFY_SUMMARY {bogus}')).toBeNull()
        expect(extractNotifySummary('AGENT_NOTIFY_SUMMARY {"summary":')).toBeNull()
        expect(extractNotifySummary('AGENT_NOTIFY_SUMMARY not-json')).toBeNull()
    })

    test('drops fields with wrong types but keeps valid ones', () => {
        const text = 'AGENT_NOTIFY_SUMMARY {"version":"oops","summary":"x","action":42,"status":"done"}'
        const r = extractNotifySummary(text)
        expect(r?.summary).toBe('x')
        expect(r?.status).toBe('done')
        expect(r?.version).toBeUndefined()
        expect(r?.action).toBeUndefined()
    })

    test('ignores in-message quotes of the line - only the LAST line is parsed', () => {
        // This very test message contains the literal prefix in a quoted explanation,
        // but the trailing line is plain prose, so we return null.
        const text = `Earlier I described the format as 'AGENT_NOTIFY_SUMMARY {...}', but here is plain text.`
        expect(extractNotifySummary(text)).toBeNull()
    })

    test('returns null for whitespace-only input', () => {
        expect(extractNotifySummary('   \n\n  ')).toBeNull()
    })

    test('handles JSON with internal braces (escaped within strings)', () => {
        const text = 'AGENT_NOTIFY_SUMMARY {"summary":"thing {nested} thing","status":"done"}'
        const r = extractNotifySummary(text)
        expect(r?.summary).toBe('thing {nested} thing')
        expect(r?.status).toBe('done')
    })

    test('parses when a JSON string value mentions the token literal', () => {
        // lastIndexOf would start inside the summary value and fail.
        const text = 'AGENT_NOTIFY_SUMMARY {"summary":"Fixed AGENT_NOTIFY_SUMMARY parsing","status":"done"}'
        const r = extractNotifySummary(text)
        expect(r?.summary).toBe('Fixed AGENT_NOTIFY_SUMMARY parsing')
        expect(r?.status).toBe('done')
    })

    test('parses glued prose when a JSON string value mentions the token', () => {
        const text = 'Done.AGENT_NOTIFY_SUMMARY {"summary":"mentions AGENT_NOTIFY_SUMMARY here","status":"done"}'
        const r = extractNotifySummary(text)
        expect(r?.summary).toBe('mentions AGENT_NOTIFY_SUMMARY here')
        expect(r?.status).toBe('done')
    })

    test('splits a clean footer into visible prose and metadata', () => {
        const text = 'Did the work.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done","action":"Review it"}'
        const result = splitNotifySummary(text)

        expect(result?.visibleText).toBe('Did the work.')
        expect(result?.summary).toEqual({ summary: 'Done', status: 'done', action: 'Review it' })
    })

    test('splits a footer glued to prose on the last line', () => {
        const text = 'Did the work.\nOwnership session pinged.AGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}'
        const result = splitNotifySummary(text)

        expect(result?.visibleText).toBe('Did the work.\nOwnership session pinged.')
        expect(result?.summary.summary).toBe('Done')
    })

    test('preserves leading indentation when a footer is glued to Markdown prose', () => {
        const text = '- item\n    nested line.AGENT_NOTIFY_SUMMARY {"summary":"Done"}'
        const result = splitNotifySummary(text)

        expect(result?.visibleText).toBe('- item\n    nested line.')
    })

    test('returns null when the footer is not a compliant final line', () => {
        expect(splitNotifySummary('AGENT_NOTIFY_SUMMARY {"summary":"Done"}\nMore prose')).toBeNull()
        expect(splitNotifySummary('Plain prose')).toBeNull()
    })
})

describe('stripNotifySummaryFooter', () => {
    const FOOTER = 'AGENT_NOTIFY_SUMMARY {"version":1,"status":"done","summary":"ok","action":"Ship it"}'

    test('removes a trailing well-formed footer and keeps prose', () => {
        expect(stripNotifySummaryFooter(`Here is the answer.\n\n${FOOTER}`)).toBe('Here is the answer.')
    })

    test('keeps glued last-line prose when stripping the footer', () => {
        expect(stripNotifySummaryFooter(`Ownership session pinged.${FOOTER}`)).toBe(
            'Ownership session pinged.'
        )
    })

    test('tolerates trailing whitespace after the footer line', () => {
        expect(stripNotifySummaryFooter(`Done.\n${FOOTER}\n\n`)).toBe('Done.')
    })

    test('leaves malformed or truncated footers untouched', () => {
        const truncated = 'Done.\nAGENT_NOTIFY_SUMMARY {"summary":'
        const bogus = 'Done.\nAGENT_NOTIFY_SUMMARY {bogus}'
        expect(stripNotifySummaryFooter(truncated)).toBe(truncated)
        expect(stripNotifySummaryFooter(bogus)).toBe(bogus)
    })

    test('leaves mid-body mentions and non-final footers untouched', () => {
        const mid = 'See AGENT_NOTIFY_SUMMARY {"status":"done","summary":"mid"} for the contract.'
        const nonFinal = `${FOOTER}\nMore prose`
        expect(stripNotifySummaryFooter(mid)).toBe(mid)
        expect(stripNotifySummaryFooter(nonFinal)).toBe(nonFinal)
    })

    test('returns empty string when the message is only a footer', () => {
        expect(stripNotifySummaryFooter(FOOTER)).toBe('')
    })
})

describe('extractNotifySummary + extractAssistantPlainText (integration)', () => {
    test('codex assistant text containing a trailing summary line', () => {
        const content = {
            type: 'codex',
            data: {
                type: 'message',
                message: 'Did the work.\n\nAGENT_NOTIFY_SUMMARY {"summary":"Done","status":"done"}'
            }
        }
        const text = extractAssistantPlainText(content)
        expect(text).not.toBeNull()
        const r = extractNotifySummary(text!)
        expect(r?.summary).toBe('Done')
    })

    test('claude SDK output with summary in the last text block', () => {
        const content = {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    content: [
                        { type: 'text', text: 'Quick update.' },
                        { type: 'text', text: 'AGENT_NOTIFY_SUMMARY {"summary":"All checks green","status":"done","action":"Merge PR"}' }
                    ]
                }
            }
        }
        const text = extractAssistantPlainText(content)
        const r = extractNotifySummary(text!)
        expect(r?.summary).toBe('All checks green')
        expect(r?.action).toBe('Merge PR')
    })
})

describe('isRedundantGoalStatusEventContent (regression-guard for messages.ts edits)', () => {
    test.each([
        'Goal active · build the thing',
        'Goal blocked',
        'Goal limited by usage · 8016 tokens'
    ])('detects redundant goal status event: %s', (message) => {
        const value = {
            role: 'agent',
            content: {
                type: 'event',
                data: { type: 'message', message }
            }
        }
        expect(isRedundantGoalStatusEventContent(value)).toBe(true)
    })
})

describe('reasoning stream identity', () => {
    function reasoningContent(overrides: Record<string, unknown> = {}) {
        return {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: { type: 'reasoning', message: 'thinking', id: 'stream-1', ...overrides }
            }
        }
    }

    test('reads the stream id from a live snapshot', () => {
        expect(getReasoningStreamId(reasoningContent({ live: true }))).toBe('stream-1')
        expect(getLiveReasoningStreamId(reasoningContent({ live: true }))).toBe('stream-1')
    })

    test('treats a settled reasoning message as part of the stream but not as live', () => {
        expect(getReasoningStreamId(reasoningContent())).toBe('stream-1')
        expect(getLiveReasoningStreamId(reasoningContent())).toBeNull()
    })

    test('does not treat a non-boolean live marker as live', () => {
        expect(getLiveReasoningStreamId(reasoningContent({ live: 'yes' }))).toBeNull()
    })

    test.each([
        ['a user-role envelope', { role: 'user', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', id: 'stream-1' } } }],
        ['a different payload type', { role: 'agent', content: { type: 'event', data: { type: 'reasoning', id: 'stream-1' } } }],
        ['a different data type', { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'message', id: 'stream-1' } } }],
        ['a missing id', { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning' } } }],
        ['a blank id', { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', id: '   ' } } }],
        ['a non-string id', { role: 'agent', content: { type: AGENT_MESSAGE_PAYLOAD_TYPE, data: { type: 'reasoning', id: 7 } } }],
        ['a non-object value', 'reasoning']
    ])('returns null for %s', (_label, value) => {
        expect(getReasoningStreamId(value)).toBeNull()
        expect(getLiveReasoningStreamId(value)).toBeNull()
    })
})
