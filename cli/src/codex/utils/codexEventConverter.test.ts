import { describe, expect, it } from 'vitest';
import {
    convertCodexEvent,
    createCodexEventConverter,
    type CodexConversionAction,
    type CodexMessage
} from './codexEventConverter';

function getAgentMessages(actions: CodexConversionAction[]): CodexMessage[] {
    return actions.flatMap((action) => action.type === 'agent-message' ? [action.message] : []);
}

describe('convertCodexEvent', () => {
    it('extracts session_meta id', () => {
        const result = convertCodexEvent({
            type: 'session_meta',
            payload: { id: 'session-123' }
        });

        expect(result).toEqual({ sessionId: 'session-123' });
    });

    it('converts agent_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'hello' }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'message',
            message: 'hello'
        });
    });

    it('converts user_message events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello user' }
        });

        expect(result?.userMessage).toBe('hello user');
    });

    it('converts Codex 0.147 completed user-message items', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-147',
                item: {
                    type: 'UserMessage',
                    id: 'user-147',
                    content: [{ type: 'Text', text: 'hello from 0.147' }]
                }
            }
        });

        expect(result).toMatchObject({
            turnId: 'turn-147',
            userActivity: true,
            userMessage: 'hello from 0.147'
        });
    });

    it('marks image-only completed user-message items as activity', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-image',
                item: {
                    type: 'UserMessage',
                    id: 'user-image',
                    content: [{ type: 'Image', image_url: 'data:image/png;base64,abc' }]
                }
            }
        });

        expect(result).toEqual({
            turnId: 'turn-image',
            userActivity: true
        });
    });

    it('converts Codex 0.147 completed agent-message items', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-147',
                item: {
                    type: 'AgentMessage',
                    id: 'agent-147',
                    phase: 'commentary',
                    content: [{ type: 'Text', text: 'visible commentary' }]
                }
            }
        });

        expect(result).toEqual({
            turnId: 'turn-147',
            messages: [{
                type: 'message',
                message: 'visible commentary',
                id: 'agent-147'
            }]
        });
    });

    it('marks native token counts as inclusive of cached input', () => {
        const info = {
            total_token_usage: {
                input_tokens: 120,
                cached_input_tokens: 20,
                output_tokens: 12
            }
        };
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'token_count', info }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'token_count',
            usageSchema: 'hapi.usage.v1',
            inputTokenSemantics: 'includes-cache',
            info
        });
    });

    it('converts completed plan items into proposed plan messages', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: { type: 'Plan', id: 'plan-1', text: '## Plan\n\n1. Inspect\n2. Implement' }
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'proposed_plan',
            plan: '## Plan\n\n1. Inspect\n2. Implement',
            id: 'plan-1',
            turnId: 'turn-1'
        });
    });

    it('ignores empty completed plan items', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: { type: 'Plan', id: 'plan-1', text: '   ' }
            }
        });

        expect(result).toBeNull();
    });

    it('ignores completed plan items without a turn id', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                item: { type: 'Plan', id: 'plan-1', text: '## Plan' }
            }
        });

        expect(result).toBeNull();
    });

    it.each(['task_complete', 'turn_aborted', 'task_failed'])('converts %s into a turn boundary', (type) => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type, turn_id: 'turn-1' }
        });

        expect(result).toEqual({ finishedTurnId: 'turn-1' });
    });

    it.each([
        ['user text', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'hello from response_item user' }]
            }
        }],
        ['user image', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }]
            }
        }],
        ['injected user context', {
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: '# AGENTS.md\n<environment_context>hidden context</environment_context>' }]
            }
        }]
    ])('ignores %s response_item messages', (_name, event) => {
        expect(convertCodexEvent(event)).toBeNull();
    });

    it('converts assistant response items that have no semantic mirror', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'final-1',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'complete final answer' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });

        expect(result).toEqual({
            turnId: 'turn-1',
            messages: [{
                type: 'message',
                message: 'complete final answer',
                id: 'final-1'
            }]
        });
    });

    it('removes the plan envelope from assistant response items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'plan-preface',
                role: 'assistant',
                phase: 'final_answer',
                content: [{
                    type: 'output_text',
                    text: 'visible preface\n\n<proposed_plan>## Hidden duplicate plan</proposed_plan>'
                }]
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'message',
            message: 'visible preface'
        });
    });

    it('deduplicates legacy and 0.147 semantic messages against response items', () => {
        const convert = createCodexEventConverter();

        expect(convert({
            type: 'turn_context',
            payload: { turn_id: 'turn-1' }
        })).toEqual([]);
        expect(getAgentMessages(convert({
            type: 'event_msg',
            payload: { type: 'agent_message', phase: 'commentary', message: 'legacy commentary' }
        }))[0]).toMatchObject({ message: 'legacy commentary' });
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'legacy-commentary',
                role: 'assistant',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'legacy commentary' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);

        expect(getAgentMessages(convert({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: {
                    type: 'AgentMessage',
                    id: 'new-commentary',
                    phase: 'commentary',
                    content: [{ type: 'Text', text: 'new commentary' }]
                }
            }
        }))[0]).toMatchObject({ message: 'new commentary' });
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'new-commentary',
                role: 'assistant',
                phase: 'commentary',
                content: [{ type: 'output_text', text: 'new commentary' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);

        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'response-only-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'response-only final' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);
        const completed = convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        });
        expect(getAgentMessages(completed)).toEqual([
            expect.objectContaining({ message: 'response-only final' })
        ]);
        expect(completed.at(-1)).toEqual({ type: 'turn-finished', turnId: 'turn-1' });
    });

    it('flushes older finals before emitting a later semantic mirror', () => {
        const convert = createCodexEventConverter();

        convert({
            type: 'turn_context',
            payload: { turn_id: 'turn-1' }
        });
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'final-a',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible final A' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'final-b',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible final B' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);

        const mirrored = convert({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: {
                    type: 'AgentMessage',
                    id: 'final-b',
                    phase: 'final_answer',
                    content: [{ type: 'Text', text: 'visible final B' }]
                }
            }
        });
        expect(getAgentMessages(mirrored)).toEqual([{
            type: 'message',
            message: 'visible final A',
            id: 'final-a'
        }, {
            type: 'message',
            message: 'visible final B',
            id: 'final-b'
        }]);
        expect(convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        })).toEqual([{ type: 'turn-finished', turnId: 'turn-1' }]);
    });

    it('does not register a semantic message after pairing it with a buffered response', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'paired-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'same visible text' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });
        expect(getAgentMessages(convert({
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                turn_id: 'turn-1',
                item: {
                    type: 'AgentMessage',
                    id: 'paired-final',
                    phase: 'final_answer',
                    content: [{ type: 'Text', text: 'same visible text' }]
                }
            }
        }))).toEqual([{
            type: 'message',
            message: 'same visible text',
            id: 'paired-final'
        }]);

        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'response-only-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'same visible text' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);
        expect(getAgentMessages(convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        }))).toEqual([{
            type: 'message',
            message: 'same visible text',
            id: 'response-only-final'
        }]);
    });

    it('finalizes a response-only answer when the event stream ends', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'final-at-eof',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible answer at EOF' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);

        expect(getAgentMessages(convert.finalize())).toEqual([{
            type: 'message',
            message: 'visible answer at EOF',
            id: 'final-at-eof'
        }]);
        expect(convert.finalize()).toEqual([]);
    });

    it('flushes a pending final before subsequent user activity', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'visible-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible final answer' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);

        expect(convert({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'queued follow-up' }
        })).toEqual([{
            type: 'agent-message',
            turnId: 'turn-1',
            message: {
                type: 'message',
                message: 'visible final answer',
                id: 'visible-final'
            }
        }, {
            type: 'user-message',
            message: 'queued follow-up'
        }]);
    });

    it('flushes a pending final before subsequent tool activity', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'visible-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible final answer' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });

        expect(getAgentMessages(convert({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'ReadFile',
                call_id: 'call-read',
                arguments: '{"path":"README.md"}'
            }
        }))).toEqual([{
            type: 'message',
            message: 'visible final answer',
            id: 'visible-final'
        }, expect.objectContaining({
            type: 'tool-call',
            name: 'ReadFile',
            callId: 'call-read'
        })]);
    });

    it('drops only a confirmed compaction summary and flushes earlier finals', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'earlier-visible-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'earlier visible final answer' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });
        convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'compaction-summary',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'internal context summary for the next model' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });

        expect(getAgentMessages(convert({
            type: 'compacted',
            payload: {
                message: 'Compaction checkpoint prefix\ninternal context summary for the next model'
            }
        }))).toEqual([{
            type: 'message',
            message: 'earlier visible final answer',
            id: 'earlier-visible-final'
        }]);
        expect(convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        })).toEqual([{ type: 'turn-finished', turnId: 'turn-1' }]);
    });

    it('matches an indented compaction summary after the checkpoint prefix', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'indented-compaction-summary',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: '    internal context summary' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });

        expect(convert({
            type: 'compacted',
            payload: { message: 'Compaction checkpoint prefix\n    internal context summary' }
        })).toEqual([]);
        expect(convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        })).toEqual([{ type: 'turn-finished', turnId: 'turn-1' }]);
    });

    it('does not let token counts confirm a pending final', () => {
        const convert = createCodexEventConverter();

        convert({ type: 'turn_context', payload: { turn_id: 'turn-1' } });
        convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'visible-final',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible final answer' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        });

        const tokenCount = convert({
            type: 'event_msg',
            payload: { type: 'token_count', info: { total_token_usage: {} } }
        });
        expect(getAgentMessages(tokenCount)).toEqual([
            expect.objectContaining({ type: 'token_count' })
        ]);

        const completed = convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        });
        expect(getAgentMessages(completed)).toEqual([{
            type: 'message',
            message: 'visible final answer',
            id: 'visible-final'
        }]);
    });

    it('keeps a pending visible final when remote compaction has no raw summary item', () => {
        const convert = createCodexEventConverter();

        convert({
            type: 'turn_context',
            payload: { turn_id: 'turn-1' }
        });
        expect(convert({
            type: 'response_item',
            payload: {
                type: 'message',
                id: 'visible-before-remote-compaction',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'visible before remote compaction' }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
            }
        })).toEqual([]);
        expect(convert({
            type: 'compacted',
            payload: {
                message: '',
                replacement_history: [{
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: 'remote checkpoint summary' }]
                }]
            }
        })).toEqual([]);
        const completed = convert({
            type: 'event_msg',
            payload: { type: 'task_complete', turn_id: 'turn-1' }
        });
        expect(getAgentMessages(completed)).toEqual([{
            type: 'message',
            message: 'visible before remote compaction',
            id: 'visible-before-remote-compaction'
        }]);
        expect(completed.at(-1)).toEqual({ type: 'turn-finished', turnId: 'turn-1' });
    });

    it('converts reasoning events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning', text: 'thinking' }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'reasoning',
            message: 'thinking'
        });
    });

    it('converts reasoning delta events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            payload: { type: 'agent_reasoning_delta', delta: 'step' }
        });

        expect(result?.messages?.[0]).toEqual({
            type: 'reasoning-delta',
            delta: 'step'
        });
    });

    it('converts function_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call',
                name: 'ToolName',
                call_id: 'call-1',
                arguments: '{"foo":"bar"}'
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name: 'ToolName',
            callId: 'call-1',
            input: { foo: 'bar' }
        });
    });

    it('converts function_call_output items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'function_call_output',
                call_id: 'call-2',
                output: { ok: true }
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-2',
            output: { ok: true }
        });
    });

    it.each([
        ['exec', 'ls -la'],
        ['apply_patch', '*** Begin Patch\n*** End Patch']
    ])('converts %s custom_tool_call items', (name, input) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name,
                call_id: `call-${name}`,
                input
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name,
            callId: `call-${name}`,
            input
        });
    });

    it.each([
        ['string', 'command output'],
        ['array', [{ type: 'input_text', text: 'patch applied' }]]
    ])('preserves %s custom_tool_call_output values', (_name, output) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call_output',
                call_id: 'call-custom-output',
                output
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-custom-output',
            output
        });
    });

    it('preserves the turn id for custom exec wrapper correlation', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'custom_tool_call',
                name: 'exec',
                call_id: 'call-exec-turn',
                input: 'await tools.exec_command({ cmd: "pwd" });',
                internal_chat_message_metadata_passthrough: {
                    turn_id: 'turn-1'
                }
            }
        });

        expect(result?.turnId).toBe('turn-1');
    });

    it('converts tool_search_call items', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'tool_search_call',
                call_id: 'call-tool-search',
                arguments: { query: 'hapi change title', limit: 5 }
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name: 'ToolSearch',
            callId: 'call-tool-search',
            input: { query: 'hapi change title', limit: 5 }
        });
    });

    it('converts tool_search_output items', () => {
        const tools = [{ name: 'mcp__hapi', description: 'Hapi tools' }];
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'tool_search_output',
                call_id: 'call-tool-search',
                execution: 'client',
                status: 'completed',
                tools
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call-result',
            callId: 'call-tool-search',
            output: { execution: 'client', tools }
        });
    });

    it('converts a completed web_search_call into a paired call and result', () => {
        const action = {
            type: 'search',
            query: 'Codex transcript format',
            queries: ['Codex transcript format']
        };
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'web_search_call',
                status: 'completed',
                action
            }
        });

        expect(result?.messages).toEqual([{
            type: 'tool-call',
            name: 'WebSearch',
            callId: expect.any(String),
            input: action,
            id: expect.any(String)
        }, {
            type: 'tool-call-result',
            callId: expect.any(String),
            output: null,
            id: expect.any(String)
        }]);
        expect(result?.messages?.[1]).toMatchObject({
            callId: result?.messages?.[0]?.type === 'tool-call'
                ? result.messages[0].callId
                : undefined
        });
    });

    it('uses an empty input for older web_search_call items without an action', () => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'web_search_call',
                status: 'completed'
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'tool-call',
            name: 'WebSearch',
            input: {}
        });
    });

    it.each(['failed', 'error'])('marks a %s web_search_call result as an error', (status) => {
        const result = convertCodexEvent({
            type: 'response_item',
            payload: {
                type: 'web_search_call',
                status,
                action: { type: 'search', query: 'failing query' }
            }
        });

        expect(result?.messages?.[1]).toMatchObject({
            type: 'tool-call-result',
            output: null,
            is_error: true
        });
    });

    it.each([
        ['custom tool call without a name', {
            type: 'custom_tool_call',
            call_id: 'call-missing-name',
            input: 'pwd'
        }],
        ['custom tool call without a call id', {
            type: 'custom_tool_call',
            name: 'exec',
            input: 'pwd'
        }],
        ['custom tool output without a call id', {
            type: 'custom_tool_call_output',
            output: 'done'
        }],
        ['tool search call without a call id', {
            type: 'tool_search_call',
            arguments: { query: 'missing id' }
        }],
        ['tool search output without a call id', {
            type: 'tool_search_output',
            execution: 'client',
            tools: []
        }]
    ])('ignores %s', (_name, payload) => {
        expect(convertCodexEvent({
            type: 'response_item',
            payload
        })).toBeNull();
    });

    it('preserves thread id and scope role on token_count events', () => {
        const result = convertCodexEvent({
            type: 'event_msg',
            thread_id: 'parent-thread',
            payload: {
                type: 'token_count',
                scope_role: 'child',
                info: {
                    total_token_usage: { total_tokens: 100 }
                }
            }
        });

        expect(result?.messages?.[0]).toMatchObject({
            type: 'token_count',
            thread_id: 'parent-thread',
            threadId: 'parent-thread',
            scope_role: 'child',
            scopeRole: 'child',
            info: {
                total_token_usage: { total_tokens: 100 }
            }
        });
    });
});
