import { describe, it, expect, beforeEach } from 'vitest'
import { PiEventConverter } from './piEventConverter'

describe('PiEventConverter', () => {
    let converter: PiEventConverter

    beforeEach(() => {
        converter = new PiEventConverter()
    })

    describe('agent lifecycle events', () => {
        it('returns empty array for agent_start', () => {
            const result = converter.convert({ type: 'agent_start' } as never)
            expect(result).toEqual([])
        })

        it('returns empty array for agent_end and resets buffers', () => {
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'hello' }
            } as never)

            const result = converter.convert({ type: 'agent_end' } as never)
            expect(result).toEqual([])

            const nextResult = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'world' }
            } as never)
            expect(nextResult[0]?.message).toBe('world')
        })
    })

    describe('tool execution events', () => {
        it('converts tool_execution_start to tool-call', () => {
            const result = converter.convert({
                type: 'tool_execution_start',
                toolName: 'ReadFile',
                toolCallId: 'call-123',
                args: { path: '/tmp/test.txt' }
            } as never)

            expect(result).toHaveLength(1)
            expect(result[0]).toMatchObject({
                type: 'tool-call',
                name: 'ReadFile',
                callId: 'call-123',
                input: { path: '/tmp/test.txt' }
            })
            expect(result[0]?.id).toBeDefined()
        })

        it('converts tool_execution_end to tool-call-result', () => {
            const result = converter.convert({
                type: 'tool_execution_end',
                toolCallId: 'call-123',
                result: 'file contents here',
                isError: false
            } as never)

            expect(result).toHaveLength(1)
            expect(result[0]).toMatchObject({
                type: 'tool-call-result',
                callId: 'call-123',
                output: 'file contents here',
                is_error: false
            })
        })

        it('converts tool_execution_end with error flag', () => {
            const result = converter.convert({
                type: 'tool_execution_end',
                toolCallId: 'call-456',
                result: 'file not found',
                isError: true
            } as never)

            expect(result[0]).toMatchObject({
                type: 'tool-call-result',
                callId: 'call-456',
                is_error: true
            })
        })

        it('extracts text from content array in tool result', () => {
            const result = converter.convert({
                type: 'tool_execution_end',
                toolCallId: 'call-789',
                result: {
                    content: [
                        { type: 'text', text: 'line 1' },
                        { type: 'image', data: 'ignored' },
                        { type: 'text', text: 'line 2' }
                    ]
                },
                isError: false
            } as never)

            expect(result[0]?.output).toBe('line 1\nline 2')
        })

        it('returns raw result when content is not an array', () => {
            const result = converter.convert({
                type: 'tool_execution_end',
                toolCallId: 'call-abc',
                result: { someKey: 'someValue' },
                isError: false
            } as never)

            expect(result[0]?.output).toEqual({ someKey: 'someValue' })
        })
    })

    describe('message_update text handling', () => {
        it('accumulates text_delta into message buffer', () => {
            const result1 = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'Hello' }
            } as never)

            expect(result1[0]).toMatchObject({
                type: 'message',
                message: 'Hello'
            })

            const result2 = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: ' World' }
            } as never)

            expect(result2[0]).toMatchObject({
                type: 'message',
                message: 'Hello World'
            })
        })

        it('handles undefined delta gracefully', () => {
            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta' }
            } as never)

            expect(result[0]?.message).toBe('')
        })
    })

    describe('message_update thinking handling', () => {
        it('accumulates thinking_delta silently', () => {
            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me think...' }
            } as never)

            expect(result).toEqual([])
        })

        it('converts thinking_end to PiThinking tool-call pair', () => {
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_delta', delta: 'Step 1: ' }
            } as never)
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_delta', delta: 'analyze the problem' }
            } as never)

            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_end' }
            } as never)

            expect(result).toHaveLength(2)
            expect(result[0]).toMatchObject({
                type: 'tool-call',
                name: 'PiThinking',
                input: { thinking: 'Step 1: analyze the problem' }
            })
            expect(result[1]).toMatchObject({
                type: 'tool-call-result',
                callId: result[0]?.callId,
                output: 'Step 1: analyze the problem',
                is_error: false
            })
        })

        it('returns empty for thinking_end with no accumulated thinking', () => {
            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_end' }
            } as never)

            expect(result).toEqual([])
        })
    })

    describe('message_update toolcall handling', () => {
        it('converts toolcall_end to tool-call', () => {
            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: {
                    type: 'toolcall_end',
                    toolCall: {
                        id: 'tc-001',
                        name: 'WriteFile',
                        arguments: { path: '/tmp/out.txt', content: 'data' }
                    }
                }
            } as never)

            expect(result).toHaveLength(1)
            expect(result[0]).toMatchObject({
                type: 'tool-call',
                name: 'WriteFile',
                callId: 'tc-001',
                input: { path: '/tmp/out.txt', content: 'data' }
            })
        })

        it('returns empty for toolcall_end without toolCall', () => {
            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'toolcall_end' }
            } as never)

            expect(result).toEqual([])
        })
    })

    describe('message_end handling', () => {
        it('emits final message on assistant message_end', () => {
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'Final answer' }
            } as never)

            const result = converter.convert({
                type: 'message_end',
                message: { role: 'assistant' }
            } as never)

            expect(result).toHaveLength(1)
            expect(result[0]).toMatchObject({
                type: 'message',
                message: 'Final answer'
            })
        })

        it('clears text buffer after message_end', () => {
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'First message' }
            } as never)
            converter.convert({
                type: 'message_end',
                message: { role: 'assistant' }
            } as never)

            const result = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'Second message' }
            } as never)

            expect(result[0]?.message).toBe('Second message')
        })

        it('returns empty for non-assistant message_end', () => {
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'some text' }
            } as never)

            const result = converter.convert({
                type: 'message_end',
                message: { role: 'user' }
            } as never)

            expect(result).toEqual([])
        })

        it('returns empty when text buffer is empty', () => {
            const result = converter.convert({
                type: 'message_end',
                message: { role: 'assistant' }
            } as never)

            expect(result).toEqual([])
        })
    })

    describe('ignored events', () => {
        const ignoredEventTypes = [
            'compaction_start',
            'compaction_end',
            'auto_retry_start',
            'auto_retry_end',
            'turn_start',
            'turn_end',
            'message_start',
            'tool_execution_update'
        ]

        ignoredEventTypes.forEach(eventType => {
            it(`returns empty for ${eventType}`, () => {
                const result = converter.convert({ type: eventType } as never)
                expect(result).toEqual([])
            })
        })

        it('returns empty for unknown event types', () => {
            const result = converter.convert({ type: 'some_unknown_event' } as never)
            expect(result).toEqual([])
        })
    })

    describe('reset', () => {
        it('clears both text and thinking buffers', () => {
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'text' }
            } as never)
            converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_delta', delta: 'thinking' }
            } as never)

            converter.reset()

            const textResult = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'new' }
            } as never)
            expect(textResult[0]?.message).toBe('new')

            const thinkingResult = converter.convert({
                type: 'message_update',
                assistantMessageEvent: { type: 'thinking_end' }
            } as never)
            expect(thinkingResult).toEqual([])
        })
    })
})
