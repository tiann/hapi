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

        // Regression test for the false positive flagged on PR #801 by the
        // HAPI auto-review bot: this PR adds the literal synthetic-skip
        // marker to docs/guide/cursor.md, so a Cursor read_file of that
        // file would surface the marker inside readToolCall.result.content.
        // The intercept must NOT rewrite that as a no_input_surface failure.
        it('does NOT rewrite a read_file result whose content contains the synthetic marker', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'doc1',
                session_id: 's1',
                tool_call: {
                    readToolCall: {
                        args: { path: 'docs/guide/cursor.md' },
                        result: {
                            content:
                                'Lorem ipsum ... Questions skipped by the user, continue with the information you already have ... etc.'
                        }
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'doc1',
                status: 'completed'
            });
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
        });

        it('does NOT rewrite a write_file result whose payload contains the synthetic marker', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'doc2',
                session_id: 's1',
                tool_call: {
                    writeToolCall: {
                        args: {
                            path: 'docs/guide/cursor.md',
                            content:
                                'Documenting: "Questions skipped by the user, continue with the information you already have"'
                        },
                        result: { bytesWritten: 256 }
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'doc2',
                status: 'completed'
            });
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
        });

        // Regression test for the second Major finding from the HAPI bot on
        // PR #801: a legitimate AskQuestion whose prompt text (carried in
        // `function.arguments`) quotes the synthetic-skip marker - e.g. an
        // agent debugging this exact bug - must NOT be rewritten when the
        // user has actually answered. The marker check must look only at the
        // extracted result, never the agent's input arguments.
        it('does NOT rewrite an AskQuestion whose arguments quote the marker but whose result is a real answer', async () => {
            const startedEvent = {
                type: 'tool_call',
                subtype: 'started',
                call_id: 'meta1',
                session_id: 's1',
                tool_call: {
                    function: {
                        name: 'AskQuestion',
                        arguments:
                            '{"prompt":"Do you want to handle the case where cursor-agent returns: Questions skipped by the user, continue with the information you already have"}'
                    }
                }
            } as CursorStreamEvent;
            convertCursorEventToAgentMessage(startedEvent);

            // Wait past the synthetic latency threshold so the timing
            // heuristic does not apply - this is a real user answer, not a
            // zero-latency fabrication.
            await new Promise((resolve) => setTimeout(resolve, 550));

            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'meta1',
                session_id: 's1',
                tool_call: {
                    function: {
                        name: 'AskQuestion',
                        arguments:
                            '{"prompt":"Do you want to handle the case where cursor-agent returns: Questions skipped by the user, continue with the information you already have"}',
                        result: 'yes, please add the intercept'
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'meta1',
                status: 'completed'
            });
            expect((msg as { output: unknown }).output).toBe('yes, please add the intercept');
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
        });

        it('does NOT rewrite a non-AskQuestion function tool whose result happens to contain the marker text', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'fn1',
                session_id: 's1',
                tool_call: {
                    function: {
                        name: 'MyCustomTool',
                        arguments: '{}',
                        result: {
                            note: 'Quoting: Questions skipped by the user, continue with the information you already have - end quote.'
                        }
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'fn1', status: 'completed' });
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
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
