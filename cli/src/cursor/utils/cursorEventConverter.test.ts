import { describe, it, expect, beforeEach } from 'vitest';
import {
    parseCursorEvent,
    convertCursorEventToAgentMessage,
    __resetCursorEventConverterStateForTests,
    type CursorStreamEvent
} from './cursorEventConverter';

describe('cursorEventConverter', () => {
    beforeEach(() => {
        __resetCursorEventConverterStateForTests();
    });

    describe('parseCursorEvent', () => {
        it('parses system init event', () => {
            const line =
                '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"D:\\\\projects\\\\hapi","session_id":"cec26d70-d2d5-48ac-a88b-9e820eb201cf","timestamp_ms":1772422778942}';
            const event = parseCursorEvent(line);
            expect(event).not.toBeNull();
            expect(event?.type).toBe('system');
            if (event && event.type === 'system') {
                expect(event.subtype).toBe('init');
                expect(event.session_id).toBe('cec26d70-d2d5-48ac-a88b-9e820eb201cf');
            }
        });

        it('parses assistant event', () => {
            const line =
                '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"\\n你好。"}]},"session_id":"cec26d70-d2d5-48ac-a88b-9e820eb201cf"}';
            const event = parseCursorEvent(line);
            expect(event).not.toBeNull();
            expect(event?.type).toBe('assistant');
        });

        it('parses result event', () => {
            const line =
                '{"type":"result","subtype":"success","duration_ms":12456,"is_error":false,"result":"\\n你好。","session_id":"cec26d70-d2d5-48ac-a88b-9e820eb201cf"}';
            const event = parseCursorEvent(line);
            expect(event).not.toBeNull();
            expect(event?.type).toBe('result');
        });

        it('returns null for non-JSON lines', () => {
            expect(parseCursorEvent('')).toBeNull();
            expect(parseCursorEvent('   ')).toBeNull();
            expect(parseCursorEvent('正在写入 Web 请求')).toBeNull();
        });
    });

    describe('convertCursorEventToAgentMessage', () => {
        it('converts assistant to text message', () => {
            const event = {
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
                session_id: 's1'
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(event);
            expect(msg).toEqual({ type: 'text', text: 'Hello' });
        });

        it('converts result to turn_complete', () => {
            const event = { type: 'result', subtype: 'success', session_id: 's1' } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(event);
            expect(msg).toEqual({ type: 'turn_complete', stopReason: 'success' });
        });

        it('passes through a normal tool result unchanged (read_file)', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'r1',
                session_id: 's1',
                tool_call: {
                    readToolCall: {
                        args: { path: '/tmp/x' },
                        result: { content: 'hello' }
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toEqual({
                type: 'tool_result',
                id: 'r1',
                output: { content: 'hello' },
                status: 'completed'
            });
        });
    });

    describe('#784 transitional safety: AskQuestion synthetic-skip intercept', () => {
        it('rewrites a tool_call result containing the synthetic skip string to a no_input_surface failure', () => {
            const startedEvent = {
                type: 'tool_call',
                subtype: 'started',
                call_id: 'q1',
                session_id: 's1',
                tool_call: { function: { name: 'AskQuestion', arguments: '{"q":"..."}' } }
            } as CursorStreamEvent;
            convertCursorEventToAgentMessage(startedEvent);

            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q1',
                session_id: 's1',
                tool_call: {
                    function: {
                        name: 'AskQuestion',
                        arguments: '{"q":"..."}',
                        result: 'Questions skipped by the user, continue with the information you already have'
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).not.toBeNull();
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'q1',
                status: 'failed'
            });
            const output = (msg as { output: { kind: string; message: string } }).output;
            expect(output.kind).toBe('no_input_surface');
            expect(output.message).toMatch(/cursor-agent fabricated a skip response/);
            expect(output.message).toMatch(/Re-prompt in plain text/);
        });

        it('matches the synthetic-skip string even when nested deep inside the tool_call payload', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q2',
                session_id: 's1',
                tool_call: {
                    function: {
                        name: 'AskQuestion',
                        outcome: {
                            response: {
                                text: 'Questions skipped by the user, continue with the information you already have'
                            }
                        }
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'q2', status: 'failed' });
        });

        it('rewrites a sub-500ms AskQuestion completion with a trivial result even without the synthetic string', () => {
            const startedEvent = {
                type: 'tool_call',
                subtype: 'started',
                call_id: 'q3',
                session_id: 's1',
                tool_call: { function: { name: 'AskQuestion', arguments: '{}' } }
            } as CursorStreamEvent;
            convertCursorEventToAgentMessage(startedEvent);

            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q3',
                session_id: 's1',
                tool_call: { function: { name: 'AskQuestion', arguments: '{}' } }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'q3', status: 'failed' });
            expect((msg as { output: { kind: string } }).output.kind).toBe('no_input_surface');
        });

        it('rewrites a sub-500ms completion when the converter falls back to name=unknown', () => {
            const startedEvent = {
                type: 'tool_call',
                subtype: 'started',
                call_id: 'q4',
                session_id: 's1',
                tool_call: { function: {} }
            } as CursorStreamEvent;
            convertCursorEventToAgentMessage(startedEvent);

            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q4',
                session_id: 's1',
                tool_call: { function: {} }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'q4', status: 'failed' });
        });

        it('does NOT rewrite a normal function-tool completion with a real result', () => {
            const startedEvent = {
                type: 'tool_call',
                subtype: 'started',
                call_id: 'r2',
                session_id: 's1',
                tool_call: { function: { name: 'MyCustomTool', arguments: '{}' } }
            } as CursorStreamEvent;
            convertCursorEventToAgentMessage(startedEvent);

            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'r2',
                session_id: 's1',
                tool_call: {
                    function: { name: 'MyCustomTool', arguments: '{}', result: { ok: true } }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'r2', status: 'completed' });
            expect((msg as { output: unknown }).output).not.toMatchObject({ kind: 'no_input_surface' });
        });

        it('does NOT rewrite read_file/write_file results even with empty payloads', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'rw1',
                session_id: 's1',
                tool_call: { readToolCall: { args: { path: '/tmp/x' }, result: {} } }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'rw1', status: 'completed' });
        });

        it('does NOT rewrite an AskQuestion completion that took longer than the synthetic threshold', async () => {
            const startedEvent = {
                type: 'tool_call',
                subtype: 'started',
                call_id: 'q5',
                session_id: 's1',
                tool_call: { function: { name: 'AskQuestion', arguments: '{}' } }
            } as CursorStreamEvent;
            convertCursorEventToAgentMessage(startedEvent);

            await new Promise((resolve) => setTimeout(resolve, 550));

            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q5',
                session_id: 's1',
                tool_call: { function: { name: 'AskQuestion', arguments: '{}' } }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'q5', status: 'completed' });
        });
    });
});
