import { describe, expect, it } from 'vitest';
import { AppServerEventConverter } from './appServerEventConverter';

describe('AppServerEventConverter', () => {
    it('maps thread/started', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/started', { thread: { id: 'thread-1' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-1' }]);
    });

    it('maps thread/resumed', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/resumed', { thread: { id: 'thread-2' } });

        expect(events).toEqual([{ type: 'thread_started', thread_id: 'thread-2' }]);
    });

    it('maps thread systemError to a task failure', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/status/changed', {
            thread: { id: 'thread-1' },
            status: { type: 'systemError' }
        });

        expect(events).toEqual([{
            type: 'task_failed',
            thread_id: 'thread-1',
            terminal_source: 'thread_status',
            error: 'Codex thread entered systemError'
        }]);
    });

    it('maps turn/started and completed statuses', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('turn/started', { turn: { id: 'turn-1' } });
        expect(started).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);

        const completed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Completed' });
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);

        const interrupted = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Interrupted' });
        expect(interrupted).toEqual([{ type: 'turn_aborted', turn_id: 'turn-1' }]);

        const failed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Failed', message: 'boom' });
        expect(failed).toEqual([{ type: 'task_failed', turn_id: 'turn-1', error: 'boom' }]);
    });

    it('accumulates agent message deltas', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello' });
        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: ' world' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
    });

    it('preserves thread and turn scope on item events', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', {
            itemId: 'msg-1',
            delta: 'child output',
            thread_id: 'child-thread',
            turn_id: 'child-turn'
        });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' },
            threadId: 'child-thread',
            turnId: 'child-turn'
        });

        expect(completed).toEqual([{
            type: 'agent_message',
            thread_id: 'child-thread',
            turn_id: 'child-turn',
            message: 'child output'
        }]);
    });

    it('deduplicates repeated agent message completions for the same item', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hello' });
        const first = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'AgentMessage' }
        });
        const second = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' }
        });

        expect(first).toEqual([{ type: 'agent_message', message: 'Hello' }]);
        expect(second).toEqual([]);
    });

    it('maps command execution items and output deltas', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' }
        });
        expect(started).toEqual([{
            type: 'exec_command_begin',
            call_id: 'cmd-1',
            command: 'ls'
        }]);

        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ok' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'cmd-1', type: 'commandExecution', exitCode: 0 }
        });

        expect(completed).toEqual([{
            type: 'exec_command_end',
            call_id: 'cmd-1',
            command: 'ls',
            output: 'ok',
            exit_code: 0
        }]);
    });

    it('maps MCP tool call items', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: {
                id: 'call-1',
                type: 'mcpToolCall',
                server: 'hapi',
                tool: 'change_title',
                arguments: { title: 'MCP Title' }
            }
        });
        expect(started).toEqual([{
            type: 'mcp_tool_call_begin',
            call_id: 'call-1',
            server: 'hapi',
            tool: 'change_title',
            invocation: {
                server: 'hapi',
                tool: 'change_title',
                arguments: { title: 'MCP Title' }
            }
        }]);

        const completed = converter.handleNotification('item/completed', {
            item: {
                id: 'call-1',
                type: 'mcpToolCall',
                server: 'hapi',
                tool: 'change_title',
                result: {
                    content: [{ type: 'text', text: 'done' }]
                }
            }
        });

        expect(completed).toEqual([{
            type: 'mcp_tool_call_end',
            call_id: 'call-1',
            server: 'hapi',
            tool: 'change_title',
            result: {
                content: [{ type: 'text', text: 'done' }]
            }
        }]);
    });

    it('maps MCP tool call item errors', () => {
        const converter = new AppServerEventConverter();

        const completed = converter.handleNotification('item/completed', {
            item: {
                id: 'call-1',
                type: 'mcpToolCall',
                server: 'hapi',
                tool: 'change_title',
                error: 'boom'
            }
        });

        expect(completed).toEqual([{
            type: 'mcp_tool_call_end',
            call_id: 'call-1',
            server: 'hapi',
            tool: 'change_title',
            result: { Err: 'boom' }
        }]);
    });

    it('maps Codex collab spawn agent calls', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: {
                id: 'call-spawn',
                type: 'collabAgentToolCall',
                tool: 'spawnAgent',
                prompt: 'Do side work',
                agentType: 'explorer',
                forkContext: true,
                model: 'gpt-5.5',
                reasoningEffort: 'low',
                senderThreadId: 'parent-thread',
                receiverThreadIds: []
            }
        });
        expect(started).toEqual([{
            type: 'codex_tool_call_begin',
            call_id: 'call-spawn',
            name: 'spawn_agent',
            input: {
                message: 'Do side work',
                agent_type: 'explorer',
                fork_context: true,
                model: 'gpt-5.5',
                reasoning_effort: 'low',
                sender_thread_id: 'parent-thread'
            }
        }]);

        const completed = converter.handleNotification('item/completed', {
            item: {
                id: 'call-spawn',
                type: 'collabAgentToolCall',
                tool: 'spawnAgent',
                status: 'completed',
                receiverThreadIds: ['agent-1'],
                agentsStates: {
                    'agent-1': { status: 'pendingInit', message: null }
                }
            }
        });
        expect(completed).toEqual([{
            type: 'codex_tool_call_end',
            call_id: 'call-spawn',
            name: 'spawn_agent',
            output: {
                agent_id: 'agent-1',
                agentId: 'agent-1',
                status: 'completed',
                agentsStates: {
                    'agent-1': { status: 'pendingInit', message: null }
                }
            },
            is_error: false
        }]);
    });

    it('maps Codex collab wait and close outputs for web agent views', () => {
        const converter = new AppServerEventConverter();

        const waitStarted = converter.handleNotification('item/started', {
            item: {
                id: 'call-wait',
                type: 'collabAgentToolCall',
                tool: 'wait',
                receiverThreadIds: ['agent-1', 'agent-2']
            }
        });
        expect(waitStarted).toEqual([{
            type: 'codex_tool_call_begin',
            call_id: 'call-wait',
            name: 'wait_agent',
            input: {
                targets: ['agent-1', 'agent-2']
            }
        }]);

        const waitCompleted = converter.handleNotification('item/completed', {
            item: {
                id: 'call-wait',
                type: 'collabAgentToolCall',
                tool: 'wait',
                status: 'completed',
                receiverThreadIds: ['agent-1'],
                agentsStates: {
                    'agent-1': { status: 'completed', message: '42' }
                }
            }
        });
        expect(waitCompleted).toEqual([{
            type: 'codex_tool_call_end',
            call_id: 'call-wait',
            name: 'wait_agent',
            output: {
                status: {
                    'agent-1': { completed: '42' }
                },
                timed_out: false
            },
            is_error: false
        }]);

        const closeCompleted = converter.handleNotification('item/completed', {
            item: {
                id: 'call-close',
                type: 'collabAgentToolCall',
                tool: 'closeAgent',
                status: 'completed',
                receiverThreadIds: ['agent-1'],
                agentsStates: {
                    'agent-1': { status: 'completed', message: 'done' }
                }
            }
        });
        expect(closeCompleted).toEqual([{
            type: 'codex_tool_call_end',
            call_id: 'call-close',
            name: 'close_agent',
            output: {
                previous_status: { completed: 'done' },
                agent_id: 'agent-1'
            },
            is_error: false
        }]);
    });

    it('maps reasoning deltas', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'step' });
        expect(events).toEqual([{ type: 'agent_reasoning_delta', delta: 'step' }]);
    });

    it('dedupes duplicate reasoning deltas', () => {
        const converter = new AppServerEventConverter();

        expect(converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'Hello ' }))
            .toEqual([{ type: 'agent_reasoning_delta', delta: 'Hello ' }]);
        expect(converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'Hello ' }))
            .toEqual([]);
        converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'world' });

        const completed = converter.handleNotification('item/completed', {
            item: { id: 'r1', type: 'reasoning' }
        });

        expect(completed).toEqual([{ type: 'agent_reasoning', text: 'Hello world' }]);
    });

    it('maps reasoning summary deltas', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'step' });
        expect(events).toEqual([{ type: 'agent_reasoning_delta', delta: 'step' }]);
    });

    it('deduplicates repeated reasoning completions for the same item', () => {
        const converter = new AppServerEventConverter();

        const first = converter.handleNotification('item/completed', {
            item: { id: 'r1', type: 'Reasoning', summary_text: ['Plan'] }
        });
        const second = converter.handleNotification('item/completed', {
            item: { id: 'r1', type: 'reasoning', summary_text: ['Plan'] }
        });

        expect(first).toEqual([{ type: 'agent_reasoning', text: 'Plan' }]);
        expect(second).toEqual([]);
    });



    it('maps turn plan updates into update_plan events', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/plan/updated', {
            plan: [
                { step: 'Inspect Codex events', status: 'completed' },
                { content: 'Render plan state', status: 'in_progress' },
                { title: 'Verify web DOM', status: 'pending' }
            ]
        });

        expect(events).toEqual([{
            type: 'plan_update',
            plan: [
                { step: 'Inspect Codex events', status: 'completed' },
                { step: 'Render plan state', status: 'in_progress' },
                { step: 'Verify web DOM', status: 'pending' }
            ]
        }]);
    });

    it('unwraps wrapped codex plan updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/plan_update', {
            msg: {
                type: 'plan_update',
                update: {
                    items: [
                        { text: 'Plan from wrapped event', status: 'completed' }
                    ]
                }
            }
        });

        expect(events).toEqual([{
            type: 'plan_update',
            plan: [
                { step: 'Plan from wrapped event', status: 'completed' }
            ]
        }]);
    });

    it('maps diff updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/diff/updated', { diff: 'diff --git a b' });
        expect(events).toEqual([{ type: 'turn_diff', unified_diff: 'diff --git a b' }]);
    });

    it('preserves scope on diff and token usage updates', () => {
        const converter = new AppServerEventConverter();

        const diffEvents = converter.handleNotification('turn/diff/updated', {
            threadId: 'child-thread',
            turnId: 'child-turn',
            diff: 'diff --git a b'
        });
        expect(diffEvents).toEqual([{
            type: 'turn_diff',
            thread_id: 'child-thread',
            turn_id: 'child-turn',
            unified_diff: 'diff --git a b'
        }]);

        const tokenEvents = converter.handleNotification('thread/tokenUsage/updated', {
            tokenUsage: {
                thread_id: 'child-thread',
                turn_id: 'child-turn',
                last_token_usage: {
                    input_tokens: 10,
                    output_tokens: 2
                }
            }
        });
        expect(tokenEvents).toEqual([{
            type: 'token_count',
            thread_id: 'child-thread',
            turn_id: 'child-turn',
            info: {
                thread_id: 'child-thread',
                turn_id: 'child-turn',
                last_token_usage: {
                    input_tokens: 10,
                    output_tokens: 2
                }
            }
        }]);
    });

    it('maps compact notifications with scope', () => {
        const converter = new AppServerEventConverter();

        const direct = converter.handleNotification('thread/compacted', {
            thread: { id: 'thread-1' }
        });
        expect(direct).toEqual([
            { type: 'thread_compacted', thread_id: 'thread-1' },
            { type: 'context_compacted', thread_id: 'thread-1' }
        ]);

        const wrapped = converter.handleNotification('codex/event/context_compacted', {
            msg: { type: 'context_compacted', thread_id: 'thread-2', turn_id: 'turn-2' }
        });
        expect(wrapped).toEqual([
            { type: 'thread_compacted', thread_id: 'thread-2', turn_id: 'turn-2' },
            { type: 'context_compacted', thread_id: 'thread-2', turn_id: 'turn-2' }
        ]);
    });

    it('unwraps codex/event task lifecycle', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('codex/event/task_started', {
            msg: { type: 'task_started', turn_id: 'turn-1' }
        });
        expect(started).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);

        const completed = converter.handleNotification('codex/event/task_complete', {
            msg: { type: 'task_complete', turn_id: 'turn-1' }
        });
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);
    });

    it('preserves nested scope on wrapped terminal lifecycle events', () => {
        const converter = new AppServerEventConverter();

        const completed = converter.handleNotification('codex/event/task_complete', {
            msg: {
                type: 'task_complete',
                thread: { id: 'child-thread' },
                turn: { id: 'child-turn' }
            }
        });

        expect(completed).toEqual([{
            type: 'task_complete',
            thread_id: 'child-thread',
            turn_id: 'child-turn'
        }]);
    });

    it('ignores wrapped terminal lifecycle events without turn_id', () => {
        const converter = new AppServerEventConverter();

        const completed = converter.handleNotification('codex/event/task_complete', {
            msg: { type: 'task_complete' }
        });

        expect(completed).toEqual([]);
    });

    it('unwraps codex/event agent deltas and item completion', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('codex/event/agent_message_delta', {
            msg: { type: 'agent_message_delta', item_id: 'msg-1', delta: 'Hello' }
        });
        converter.handleNotification('codex/event/agent_message_content_delta', {
            msg: { type: 'agent_message_content_delta', item_id: 'msg-1', delta: ' world' }
        });

        const completed = converter.handleNotification('codex/event/item_completed', {
            msg: {
                type: 'item_completed',
                item_id: 'msg-1',
                item: { id: 'msg-1', type: 'AgentMessage' }
            }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
    });

    it('preserves nested scope on wrapped item lifecycle events', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('codex/event/item_started', {
            msg: {
                type: 'item_started',
                thread: { id: 'child-thread' },
                turn: { id: 'child-turn' },
                item: { id: 'cmd-1', type: 'commandExecution', command: 'pwd' }
            }
        });
        expect(started).toEqual([{
            type: 'exec_command_begin',
            thread_id: 'child-thread',
            turn_id: 'child-turn',
            call_id: 'cmd-1',
            command: 'pwd'
        }]);

        const completed = converter.handleNotification('codex/event/item_completed', {
            msg: {
                type: 'item_completed',
                item_id: 'msg-1',
                item: {
                    id: 'msg-1',
                    type: 'AgentMessage',
                    message: 'child output',
                    thread: { id: 'child-thread' },
                    turn: { id: 'child-turn' }
                }
            }
        });
        expect(completed).toEqual([{
            type: 'agent_message',
            thread_id: 'child-thread',
            turn_id: 'child-turn',
            message: 'child output'
        }]);
    });

    it('unwraps codex/event reasoning completion from summary text', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('codex/event/reasoning_content_delta', {
            msg: { type: 'reasoning_content_delta', item_id: 'r1', delta: 'Plan' }
        });
        const completed = converter.handleNotification('codex/event/item_completed', {
            msg: {
                type: 'item_completed',
                item_id: 'r1',
                item: { id: 'r1', type: 'Reasoning', summary_text: ['Plan done'] }
            }
        });

        expect(completed).toEqual([{ type: 'agent_reasoning', text: 'Plan done' }]);
    });

    it('prefers canonical reasoning stream over wrapped agent_reasoning events', () => {
        const converter = new AppServerEventConverter();

        const section = converter.handleNotification('codex/event/agent_reasoning_section_break', {
            msg: { type: 'agent_reasoning_section_break', item_id: 'r1' }
        });
        const delta = converter.handleNotification('codex/event/agent_reasoning_delta', {
            msg: { type: 'agent_reasoning_delta', item_id: 'r1', delta: 'step' }
        });
        const reasoning = converter.handleNotification('codex/event/agent_reasoning', {
            msg: { type: 'agent_reasoning', item_id: 'r1', text: 'Plan' }
        });

        expect(section).toEqual([{ type: 'agent_reasoning_section_break' }]);
        expect(delta).toEqual([]);
        expect(reasoning).toEqual([]);
    });

    it('deduplicates section break when wrapped and direct summary part events share the same index', () => {
        const converter = new AppServerEventConverter();

        const wrapped = converter.handleNotification('codex/event/agent_reasoning_section_break', {
            msg: { type: 'agent_reasoning_section_break', item_id: 'r1', summary_index: 0 }
        });
        const direct = converter.handleNotification('item/reasoning/summaryPartAdded', {
            itemId: 'r1',
            summaryIndex: 0
        });

        expect(wrapped).toEqual([{ type: 'agent_reasoning_section_break' }]);
        expect(direct).toEqual([]);
    });

    it('ignores wrapped final agent message and relies on item completion', () => {
        const converter = new AppServerEventConverter();

        const wrapped = converter.handleNotification('codex/event/agent_message', {
            msg: { type: 'agent_message', item_id: 'msg-1', message: 'Hello' }
        });

        expect(wrapped).toEqual([]);
    });

    it('ignores wrapped retryable errors', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/error', {
            msg: { type: 'error', message: 'temporary', will_retry: true }
        });

        expect(events).toEqual([]);
    });

    it('maps wrapped non-retryable errors to task_failed', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/error', {
            msg: { type: 'error', message: 'fatal' }
        });

        expect(events).toEqual([{ type: 'task_failed', error: 'fatal' }]);
    });

    it('maps thread/compacted notifications', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('thread/compacted', {
            threadId: 'thread-1',
            turnId: 'turn-compact'
        });

        expect(events).toEqual([
            {
                type: 'thread_compacted',
                thread_id: 'thread-1',
                turn_id: 'turn-compact'
            },
            {
                type: 'context_compacted',
                thread_id: 'thread-1',
                turn_id: 'turn-compact'
            }
        ]);
    });

    it('ignores compacted notifications without thread ids', () => {
        const converter = new AppServerEventConverter();

        expect(converter.handleNotification('thread/compacted', { turnId: 'turn-compact' })).toEqual([]);
        expect(converter.handleNotification('codex/event/context_compacted', {
            msg: { type: 'context_compacted', turn_id: 'turn-compact' }
        })).toEqual([]);
    });

    it('unwraps context_compacted events', () => {
        const converter = new AppServerEventConverter();
        const events = converter.handleNotification('codex/event/context_compacted', {
            msg: { type: 'context_compacted', thread_id: 'thread-1', turn_id: 'turn-compact' }
        });

        expect(events).toEqual([
            {
                type: 'thread_compacted',
                thread_id: 'thread-1',
                turn_id: 'turn-compact'
            },
            {
                type: 'context_compacted',
                thread_id: 'thread-1',
                turn_id: 'turn-compact'
            }
        ]);
    });

});
