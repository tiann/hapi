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

    it('handles cumulative agent-message deltas without duplication', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hey' });
        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hey!' });
        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-1', delta: 'Hey! 👋' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'agentMessage' }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hey! 👋' }]);
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

    it('handles cumulative command output deltas without duplication', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/started', {
            item: { id: 'cmd-1', type: 'commandExecution', command: 'echo hi' }
        });

        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'A' });
        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'AB' });
        converter.handleNotification('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'ABC' });

        const completed = converter.handleNotification('item/completed', {
            item: { id: 'cmd-1', type: 'commandExecution', exitCode: 0 }
        });

        expect(completed).toEqual([{
            type: 'exec_command_end',
            call_id: 'cmd-1',
            command: 'echo hi',
            output: 'ABC',
            exit_code: 0
        }]);
    });

    it('maps reasoning deltas', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('item/reasoning/textDelta', { itemId: 'r1', delta: 'step' });
        expect(events).toEqual([{ type: 'agent_reasoning_delta', delta: 'step' }]);
    });

    it('maps wrapped codex agent message deltas and completion', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('codex/event/agent_message_content_delta', {
            msg: { type: 'agent_message_content_delta', item_id: 'msg-1', delta: 'Hello' }
        });
        converter.handleNotification('codex/event/agent_message_content_delta', {
            msg: { type: 'agent_message_content_delta', item_id: 'msg-1', delta: ' world' }
        });
        const completed = converter.handleNotification('codex/event/item_completed', {
            msg: { type: 'item_completed', item: { id: 'msg-1', type: 'AgentMessage' } }
        });

        expect(completed).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
    });

    it('emits item_activity when mcptoolcall starts', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'mcp-1', type: 'mcpToolCall' }
        });
        expect(started).toEqual([{
            type: 'item_activity',
            item_type: 'mcptoolcall',
            item_id: 'mcp-1'
        }]);

        const completed = converter.handleNotification('item/completed', {
            item: { id: 'mcp-1', type: 'mcpToolCall' }
        });
        expect(completed).toEqual([]);
    });

    it('emits item_activity when websearch starts', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'web-1', type: 'webSearch' }
        });
        expect(started).toEqual([{
            type: 'item_activity',
            item_type: 'websearch',
            item_id: 'web-1'
        }]);

        const completed = converter.handleNotification('item/completed', {
            item: { id: 'web-1', type: 'webSearch' }
        });
        expect(completed).toEqual([]);
    });

    it('emits item_activity on agentMessage start and agent_message on completion', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'msg-2', type: 'agentMessage' }
        });
        expect(started).toEqual([{
            type: 'item_activity',
            item_type: 'agentmessage',
            item_id: 'msg-2'
        }]);

        converter.handleNotification('item/agentMessage/delta', { itemId: 'msg-2', delta: 'done' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'msg-2', type: 'agentMessage' }
        });
        expect(completed).toEqual([{ type: 'agent_message', message: 'done' }]);
    });

    it('emits item_activity on reasoning start and agent_reasoning on completion', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('item/started', {
            item: { id: 'r-2', type: 'reasoning' }
        });
        expect(started).toEqual([{
            type: 'item_activity',
            item_type: 'reasoning',
            item_id: 'r-2'
        }]);

        converter.handleNotification('item/reasoning/textDelta', { itemId: 'r-2', delta: 'think' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'r-2', type: 'reasoning' }
        });
        expect(completed).toEqual([{ type: 'agent_reasoning', text: 'think' }]);
    });

    it('dedupes duplicate wrapped + direct completion for same agent message item', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('codex/event/agent_message_content_delta', {
            msg: { type: 'agent_message_content_delta', item_id: 'msg-1', delta: 'Hello world' }
        });

        const wrapped = converter.handleNotification('codex/event/item_completed', {
            msg: { type: 'item_completed', item: { id: 'msg-1', type: 'AgentMessage' } }
        });
        const direct = converter.handleNotification('item/completed', {
            item: { id: 'msg-1', type: 'AgentMessage' }
        });

        expect(wrapped).toEqual([{ type: 'agent_message', message: 'Hello world' }]);
        expect(direct).toEqual([]);
    });

    it('maps diff updates', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/diff/updated', { diff: 'diff --git a b' });
        expect(events).toEqual([{ type: 'turn_diff', unified_diff: 'diff --git a b' }]);
    });

    it('maps wrapped command events and decodes output chunks', () => {
        const converter = new AppServerEventConverter();

        const started = converter.handleNotification('codex/event/exec_command_begin', {
            msg: { type: 'exec_command_begin', call_id: 'cmd-1', command: ['/bin/zsh', '-lc', 'echo ok'] }
        });
        expect(started).toEqual([{
            type: 'exec_command_begin',
            call_id: 'cmd-1',
            command: '/bin/zsh -lc echo ok'
        }]);

        converter.handleNotification('codex/event/exec_command_output_delta', {
            msg: {
                type: 'exec_command_output_delta',
                call_id: 'cmd-1',
                chunk: Buffer.from('ok').toString('base64')
            }
        });
        const ended = converter.handleNotification('codex/event/exec_command_end', {
            msg: { type: 'exec_command_end', call_id: 'cmd-1', exit_code: 0 }
        });
        expect(ended).toEqual([{
            type: 'exec_command_end',
            call_id: 'cmd-1',
            output: 'ok',
            exit_code: 0
        }]);
    });

    it('maps plan updates and deltas', () => {
        const converter = new AppServerEventConverter();

        const updated = converter.handleNotification('turn/plan/updated', {
            plan: [{ step: 'Investigate', status: 'pending' }]
        });
        expect(updated).toEqual([{
            type: 'turn_plan_updated',
            entries: [{ step: 'Investigate', status: 'pending' }]
        }]);

        const delta = converter.handleNotification('item/plan/delta', { delta: 'Investigating…' });
        expect(delta).toEqual([{ type: 'plan_delta', delta: 'Investigating…' }]);
    });

    it('maps wrapped plan updates and token counts', () => {
        const converter = new AppServerEventConverter();

        const planUpdate = converter.handleNotification('codex/event/plan_update', {
            msg: { type: 'plan_update', plan: [{ step: 'Investigate', status: 'in_progress' }] }
        });
        expect(planUpdate).toEqual([{
            type: 'turn_plan_updated',
            entries: [{ step: 'Investigate', status: 'in_progress' }]
        }]);

        const tokenCount = converter.handleNotification('codex/event/token_count', {
            msg: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 10 } } }
        });
        expect(tokenCount).toEqual([{
            type: 'token_count',
            info: null,
            rate_limits: { primary: { used_percent: 10 } }
        }]);
    });

    it('maps codex/event/task_started to task_started', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/task_started', {
            msg: { type: 'task_started', turn_id: 'turn-1' }
        });
        expect(events).toEqual([{ type: 'task_started', turn_id: 'turn-1' }]);
    });

    it('maps codex/event/task_complete to codex_step_complete (not task_complete)', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('codex/event/task_complete', {
            msg: { type: 'task_complete', turn_id: 'turn-1' }
        });
        // Should NOT produce task_complete — that would prematurely clear thinking
        expect(events).toEqual([{ type: 'codex_step_complete' }]);
        expect(events.find(e => e.type === 'task_complete')).toBeUndefined();
    });

    it('turn/completed still produces task_complete (authoritative turn end)', () => {
        const converter = new AppServerEventConverter();

        const events = converter.handleNotification('turn/completed', {
            turn: { id: 'turn-1' }, status: 'Completed'
        });
        expect(events).toEqual([{ type: 'task_complete', turn_id: 'turn-1' }]);
    });

    it('accumulates file-change output deltas', () => {
        const converter = new AppServerEventConverter();

        converter.handleNotification('item/started', {
            item: { id: 'patch-1', type: 'fileChange', changes: [{ path: 'a.ts' }] }
        });
        converter.handleNotification('item/fileChange/outputDelta', { itemId: 'patch-1', delta: 'patched' });
        const completed = converter.handleNotification('item/completed', {
            item: { id: 'patch-1', type: 'fileChange', success: true }
        });

        expect(completed).toEqual([{
            type: 'patch_apply_end',
            call_id: 'patch-1',
            changes: [{ path: 'a.ts' }],
            stdout: 'patched',
            success: true
        }]);
    });
});
