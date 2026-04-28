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

    it('preserves thread id on completed agent messages', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-child', delta: 'Child output' });
        const completed = converter.handleNotification('item/completed', {
            threadId: 'child-thread',
            item: { id: 'msg-child', type: 'agentMessage' }
        });

        expect(completed).toEqual([{
            type: 'agent_message',
            message: 'Child output',
            thread_id: 'child-thread'
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

    it('maps collab tool calls to subagent action events', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/started', {
            item: {
                id: 'collab-1',
                type: 'collabToolCall',
                tool: 'spawnAgent',
                status: 'in_progress',
                model: 'gpt-5.3-codex',
                receiverAgents: [
                    {
                        threadId: 'child-1',
                        agentId: 'agent-1',
                        agentNickname: 'Locke',
                        agentRole: 'explorer',
                        prompt: 'Inspect routing'
                    },
                    {
                        thread_id: 'child-2',
                        agent_id: 'agent-2',
                        nickname: 'Dalton',
                        agent_type: 'worker'
                    }
                ],
                agentsStates: {
                    'child-1': { status: 'running', message: 'Scanning modules' },
                    'child-2': { status: 'pending_init' }
                }
            }
        });

        expect(events).toEqual([{
            type: 'codex_subagent_action',
            tool: 'spawnAgent',
            status: 'in_progress',
            itemId: 'collab-1',
            receiverThreadIds: ['child-1', 'child-2'],
            agents: [
                {
                    threadId: 'child-1',
                    agentId: 'agent-1',
                    nickname: 'Locke',
                    role: 'explorer',
                    model: 'gpt-5.3-codex',
                    prompt: 'Inspect routing',
                    status: 'running',
                    message: 'Scanning modules'
                },
                {
                    threadId: 'child-2',
                    agentId: 'agent-2',
                    nickname: 'Dalton',
                    role: 'worker',
                    model: 'gpt-5.3-codex',
                    status: 'pending_init'
                }
            ]
        }]);
    });

    it('maps singular collab agent calls to subagent action events', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/item_completed', {
            msg: {
                type: 'item_completed',
                item_id: 'collab-2',
                item: {
                    id: 'collab-2',
                    type: 'collabAgentToolCall',
                    name: 'waitAgent',
                    status: 'completed',
                    receiver_thread_id: 'child-3',
                    receiver_agent_id: 'agent-3',
                    receiver_agent_nickname: 'Nash',
                    receiver_agent_role: 'reviewer',
                    model_name: 'gpt-5.4'
                }
            }
        });

        expect(events).toEqual([{
            type: 'codex_subagent_action',
            tool: 'waitAgent',
            status: 'completed',
            itemId: 'collab-2',
            receiverThreadIds: ['child-3'],
            agents: [{
                threadId: 'child-3',
                agentId: 'agent-3',
                nickname: 'Nash',
                role: 'reviewer',
                model: 'gpt-5.4'
            }]
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

    it('maps direct context compaction lifecycle notifications', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('thread/compact/started', {
            trigger: 'auto',
            preTokens: 123456
        });
        const completed = converter.handleNotification('thread/compacted', {
            trigger: 'auto',
            preTokens: 123456
        });

        expect(started).toEqual([{ type: 'compact-started', trigger: 'auto', preTokens: 123456 }]);
        expect(completed).toEqual([{ type: 'compact', trigger: 'auto', preTokens: 123456 }]);
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

    it('maps wrapped context compaction lifecycle events', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('codex/event/context_compaction_started', {
            msg: { type: 'context_compaction_started', trigger: 'manual', pre_tokens: 5000 }
        });
        const completed = converter.handleNotification('codex/event/context_compacted', {
            msg: { type: 'context_compacted', trigger: 'manual', pre_tokens: 5000 }
        });

        expect(started).toEqual([{ type: 'compact-started', trigger: 'manual', preTokens: 5000 }]);
        expect(completed).toEqual([{ type: 'compact', trigger: 'manual', preTokens: 5000 }]);
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
});
