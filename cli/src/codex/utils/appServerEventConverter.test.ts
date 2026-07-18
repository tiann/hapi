import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
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

    it('maps turn/started and completed statuses', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('turn/started', { turn: { id: 'turn-1' } });
        expect(started).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);

        const completed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Completed' });
        expect(completed).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);

        const interrupted = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Interrupted' });
        expect(interrupted).toEqual([{ type: 'turn_aborted', turn_id: 'turn-1' }]);

        const failed = converter.handleNotification('turn/completed', { turn: { id: 'turn-1' }, status: 'Failed', message: 'boom' });
        expect(failed).toEqual([{ type: 'task_failed', turn_id: 'turn-1', error: 'Codex task failed' }]);
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

    it('maps diff updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/diff/updated', { diff: 'diff --git a b' });
        expect(events).toEqual([{ type: 'turn_diff', unified_diff: 'diff --git a b' }]);
    });

    it('maps native thread compaction notifications', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('thread/compacted', {
            threadId: 'thread-1',
            previousTokens: 120000,
            tokens: 25000,
            diagnostics: { internal: true }
        });

        expect(events).toEqual([{
            type: 'context_compacted',
            thread_id: 'thread-1',
            previousTokens: 120000,
            tokens: 25000
        }]);
    });

    it('maps context compaction item lifecycle notifications', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { type: 'contextCompaction', id: 'compact-1' },
            threadId: 'thread-1',
            turnId: 'turn-compact'
        });
        const completed = converter.handleNotification('item/completed', {
            item: { type: 'contextCompaction', id: 'compact-1' },
            threadId: 'thread-1',
            turnId: 'turn-compact'
        });

        expect(started).toEqual([{
            type: 'task_started',
            thread_id: 'thread-1',
            turn_id: 'turn-compact'
        }]);
        expect(completed).toEqual([{
            type: 'context_compacted',
            thread_id: 'thread-1',
            turn_id: 'turn-compact'
        }]);
    });

    it('unwraps codex/event context compaction events', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/context_compacted', {
            msg: {
                type: 'context_compacted',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                previous_tokens: 1000,
                token_count: 200,
                diagnostics: { internal: true }
            }
        });

        expect(events).toEqual([{
            type: 'context_compacted',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            previousTokens: 1000,
            tokens: 200
        }]);
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

    it('emits a merged lifecycle event when a Codex subagent is spawned', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('codex/event/item_completed', {
            msg: {
                type: 'item_completed',
                item_id: 'call-spawn',
                item: {
                    id: 'call-spawn',
                    type: 'function_call',
                    namespace: 'multi_agent_v1',
                    name: 'spawn_agent',
                    call_id: 'call-spawn',
                    arguments: JSON.stringify({
                        agent_type: 'default',
                        message: 'Review the HAPI diff'
                    })
                }
            }
        });
        const completed = converter.handleNotification('codex/event/item_completed', {
            msg: {
                type: 'item_completed',
                item_id: 'out-spawn',
                item: {
                    id: 'out-spawn',
                    type: 'function_call_output',
                    call_id: 'call-spawn',
                    output: JSON.stringify({
                        agent_id: 'agent-1',
                        nickname: 'Boyle'
                    })
                }
            }
        });

        expect(started).toEqual([]);
        expect(completed).toEqual([{
            type: 'codex_subagent_spawned',
            call_id: 'call-spawn',
            agent_id: 'agent-1',
            nickname: 'Boyle',
            agent_type: 'default',
            message: 'Review the HAPI diff'
        }]);
    });

    it('emits lifecycle events when Codex subagents are waited for and closed', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/completed', {
            item: {
                id: 'call-wait',
                type: 'function_call',
                namespace: 'multi_agent_v1',
                name: 'wait_agent',
                call_id: 'call-wait',
                arguments: JSON.stringify({ targets: ['agent-1'] })
            }
        });
        const waited = converter.handleNotification('item/completed', {
            item: {
                id: 'out-wait',
                type: 'function_call_output',
                call_id: 'call-wait',
                output: JSON.stringify({
                    status: {
                        'agent-1': { completed: 'Looks good.' }
                    }
                })
            }
        });

        converter.handleNotification('item/completed', {
            item: {
                id: 'call-close',
                type: 'function_call',
                namespace: 'multi_agent_v1',
                name: 'close_agent',
                call_id: 'call-close',
                arguments: JSON.stringify({ target: 'agent-1' })
            }
        });
        const closed = converter.handleNotification('item/completed', {
            item: {
                id: 'out-close',
                type: 'function_call_output',
                call_id: 'call-close',
                output: JSON.stringify({
                    previous_status: { completed: 'Looks good.' }
                })
            }
        });

        expect(waited).toEqual([{
            type: 'codex_subagent_waited',
            call_id: 'call-wait',
            targets: ['agent-1'],
            status: {
                'agent-1': { completed: 'Looks good.' }
            }
        }]);
        expect(closed).toEqual([{
            type: 'codex_subagent_closed',
            call_id: 'call-close',
            target: 'agent-1',
            previous_status: { completed: 'Looks good.' }
        }]);
    });

    it('preserves wait_agent targets even when the wait output status is empty', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/completed', {
            item: {
                id: 'call-wait-timeout',
                type: 'function_call',
                namespace: 'multi_agent_v1',
                name: 'wait_agent',
                call_id: 'call-wait-timeout',
                arguments: JSON.stringify({
                    targets: ['agent-1', 'agent-2'],
                    timeout_ms: 30000
                })
            }
        });
        const waited = converter.handleNotification('item/completed', {
            item: {
                id: 'out-wait-timeout',
                type: 'function_call_output',
                call_id: 'call-wait-timeout',
                output: JSON.stringify({ status: {}, timed_out: true })
            }
        });

        expect(waited).toEqual([{
            type: 'codex_subagent_waited',
            call_id: 'call-wait-timeout',
            targets: ['agent-1', 'agent-2'],
            status: {}
        }]);
    });

    it('maps live app-server collabAgentToolCall lifecycle events for Codex subagents', () => {
        const converter = new AppServerEventConverter();

        const spawnStarted = converter.handleNotification('item/started', {
            item: {
                type: 'collabAgentToolCall',
                id: 'call-spawn',
                tool: 'spawnAgent',
                status: 'inProgress',
                receiverThreadIds: [],
                prompt: 'Reply exactly SMOKE_SUBAGENT_OK',
                agentsStates: {}
            }
        });
        const spawned = converter.handleNotification('item/completed', {
            item: {
                type: 'collabAgentToolCall',
                id: 'call-spawn',
                tool: 'spawnAgent',
                status: 'completed',
                receiverThreadIds: ['thread-child-1'],
                prompt: 'Reply exactly SMOKE_SUBAGENT_OK',
                model: 'gpt-5.5',
                reasoningEffort: 'low',
                agentsStates: {
                    'thread-child-1': { status: 'pendingInit', message: null }
                }
            }
        });
        const waited = converter.handleNotification('item/completed', {
            item: {
                type: 'collabAgentToolCall',
                id: 'call-wait',
                tool: 'wait',
                status: 'completed',
                receiverThreadIds: ['thread-child-1'],
                agentsStates: {
                    'thread-child-1': { status: 'completed', message: 'SMOKE_SUBAGENT_OK' }
                }
            }
        });
        const closed = converter.handleNotification('item/completed', {
            item: {
                type: 'collabAgentToolCall',
                id: 'call-close',
                tool: 'closeAgent',
                status: 'completed',
                receiverThreadIds: ['thread-child-1'],
                agentsStates: {
                    'thread-child-1': { status: 'completed', message: 'SMOKE_SUBAGENT_OK' }
                }
            }
        });

        expect(spawnStarted).toEqual([]);
        expect(spawned).toEqual([{
            type: 'codex_subagent_spawned',
            call_id: 'call-spawn',
            agent_id: 'thread-child-1',
            agent_type: 'gpt-5.5',
            message: 'Reply exactly SMOKE_SUBAGENT_OK'
        }]);
        expect(waited).toEqual([{
            type: 'codex_subagent_waited',
            call_id: 'call-wait',
            targets: ['thread-child-1'],
            status: {
                'thread-child-1': { status: 'completed', message: 'SMOKE_SUBAGENT_OK' }
            }
        }]);
        expect(closed).toEqual([{
            type: 'codex_subagent_closed',
            call_id: 'call-close',
            target: 'thread-child-1',
            previous_status: { status: 'completed', message: 'SMOKE_SUBAGENT_OK' }
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


    it('silently ignores known benign app-server notifications', () => {
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
        const converter = new AppServerEventConverter();

        expect(converter.handleNotification('thread/status/changed', {
            threadId: 'thread-1',
            status: { type: 'idle' }
        })).toEqual([]);
        expect(converter.handleNotification('serverRequest/resolved', {
            threadId: 'thread-1',
            requestId: 1
        })).toEqual([]);
        expect(converter.handleNotification('item/commandExecution/terminalInteraction', {
            threadId: 'thread-1',
            turnId: 'turn-1',
            itemId: 'cmd-1',
            stdin: ''
        })).toEqual([]);
        expect(converter.handleNotification('thread/goal/updated', {
            threadId: 'thread-1',
            turnId: null,
            goal: { objective: 'finish' }
        })).toEqual([]);
        expect(converter.handleNotification('thread/goal/cleared', {
            threadId: 'thread-1'
        })).toEqual([]);

        expect(debugSpy).not.toHaveBeenCalled();
        debugSpy.mockRestore();
    });

    it('maps wrapped non-retryable errors to a sanitized task_failed event', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/error', {
            msg: { type: 'error', message: 'fatal private prompt and sk-secret123456' }
        });

        expect(events).toEqual([{ type: 'task_failed', error: 'Codex task failed' }]);
    });

    it('logs only method and byte count for unhandled notifications', () => {
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const converter = new AppServerEventConverter();

        converter.handleNotification('private/unknown', { prompt: 'do not leak this prompt', token: 'sk-secret123456' });

        expect(debugSpy).toHaveBeenCalledWith(
            '[AppServerEventConverter] Unhandled notification',
            expect.objectContaining({ method: 'private/unknown', paramsBytes: expect.any(Number) })
        );
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('do not leak this prompt');
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain('sk-secret123456');
        debugSpy.mockRestore();
    });
});
