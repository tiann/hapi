import { describe, it, expect } from 'vitest';
import {
    parseCursorEvent,
    convertCursorEventToAgentMessage,
    type CursorStreamEvent
} from './cursorLegacyEventConverter';

describe('cursorLegacyEventConverter', () => {
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

        it('passes through a normal read_file result unchanged', () => {
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
        it('rewrites a function-shaped AskQuestion whose result contains the synthetic marker', () => {
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

        it('matches the synthetic-skip string even when nested deep inside the function payload', () => {
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

        // The marker is detected on the raw `tool_call` payload, not on
        // `extractToolResult`'s output. That matters for stream-json shapes
        // the converter labels `name=unknown` (notably the `toolu_vrtx_*`
        // Anthropic Vertex tool calls) where extractToolResult returns `{}`
        // and would otherwise hide the marker.
        it('catches the marker in a name=unknown tool whose extractToolResult would return {}', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q3',
                session_id: 's1',
                tool_call: {
                    id: 'toolu_vrtx_01ALz3pUoYRHEi8jg4hxurGp',
                    fabricated_response: {
                        text: 'Questions skipped by the user, continue with the information you already have'
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'q3', status: 'failed' });
            expect((msg as { output: { kind: string } }).output.kind).toBe('no_input_surface');
        });

        it('does NOT rewrite a normal function-tool completion with a real result', () => {
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

        // Regression test: docs/guide/cursor.md contains the literal
        // synthetic-skip marker, so a Cursor read_file of that file would
        // surface the marker inside readToolCall.result.content. The
        // intercept must NOT rewrite that as a no_input_surface failure
        // because the gate excludes read_file tool calls.
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

        // Regression for the second Major finding from the HAPI bot on
        // PR #801: a legitimate AskQuestion whose prompt text (carried
        // in `function.arguments`) quotes the synthetic-skip marker -
        // e.g. an agent debugging this exact bug - must NOT be rewritten
        // when the user has actually answered. The marker scan must look
        // only at the response portion of the tool_call, never at the
        // agent's input arguments.
        it('does NOT rewrite an AskQuestion whose arguments quote the marker but whose result is a real answer', () => {
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

        // Regression for the real-traffic false positives observed on PR #801
        // (see https://github.com/tiann/hapi/issues/784 follow-up data): a
        // legacy stream-json session carrying Anthropic Vertex Claude tool
        // calls surfaces every one of them as `name=unknown` with an empty
        // extracted result. The earlier timing-only defense-in-depth
        // rewrote those as `no_input_surface` failures. The marker-only
        // path must let them pass through normally.
        it('does NOT rewrite a fast name=unknown tool call that lacks the synthetic marker', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'toolu_vrtx_01ALz3pUoYRHEi8jg4hxurGp',
                session_id: 's1',
                tool_call: {
                    id: 'toolu_vrtx_01ALz3pUoYRHEi8jg4hxurGp',
                    name: 'TodoWrite',
                    input: { todos: [] }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'toolu_vrtx_01ALz3pUoYRHEi8jg4hxurGp',
                status: 'completed'
            });
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
        });

        // Regression for the Codex P2 finding on the fork-stage review
        // of this PR (heavygee/hapi#35): an Anthropic tool_use shape
        // `{id, name, input, ...}` with a recognizable top-level `name`
        // must be gate-rejected by the AskQuestion-name set, AND its
        // agent-controlled `input` field must be excluded from the
        // marker scan even if the gate were to pass. Concrete case:
        // an agent debugging or documenting this very bug whose
        // TodoWrite payload quotes the synthetic-skip marker verbatim.
        it('does NOT rewrite an Anthropic tool_use shape whose input quotes the marker (Codex P2 regression)', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'toolu_vrtx_meta',
                session_id: 's1',
                tool_call: {
                    id: 'toolu_vrtx_meta',
                    name: 'TodoWrite',
                    input: {
                        todos: [
                            {
                                content:
                                    'Document Questions skipped by the user, continue with the information you already have'
                            }
                        ]
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'toolu_vrtx_meta',
                status: 'completed'
            });
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
        });

        // Defense-in-depth companion to the above: even if a tool shape
        // somehow reached this code path with `name=unknown` (no top-
        // level name field) and the marker buried inside its `input`,
        // the AGENT_INPUT_KEYS exclusion must still suppress the
        // rewrite - the marker only counts as fabricated when it lives
        // outside agent-controlled input fields.
        it('does NOT rewrite a name=unknown shape whose marker lives only inside agent input', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'input1',
                session_id: 's1',
                tool_call: {
                    id: 'toolu_vrtx_input',
                    input: {
                        prompt:
                            'Quoting bug: Questions skipped by the user, continue with the information you already have'
                    }
                }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({
                type: 'tool_result',
                id: 'input1',
                status: 'completed'
            });
        });

        it('does NOT rewrite an empty function-shaped AskQuestion that lacks the marker', () => {
            const completedEvent = {
                type: 'tool_call',
                subtype: 'completed',
                call_id: 'q4',
                session_id: 's1',
                tool_call: { function: { name: 'AskQuestion', arguments: '{}' } }
            } as CursorStreamEvent;
            const msg = convertCursorEventToAgentMessage(completedEvent);
            expect(msg).toMatchObject({ type: 'tool_result', id: 'q4', status: 'completed' });
            expect((msg as { output: unknown }).output).not.toMatchObject({
                kind: 'no_input_surface'
            });
        });
    });
});
