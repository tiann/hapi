import { describe, expect, it } from 'vitest';
import {
    buildWrappedErrorEvent,
    buildWrappedItemNotification,
    buildWrappedReasoningSectionBreakNotification,
    buildWrappedTerminalEvent,
    buildWrappedTextDeltaNotification,
    isIgnoredWrappedCodexEventType,
    isWrappedTerminalEventType
} from './appServerWrappedEvents';

describe('app-server wrapped event helpers', () => {
    it('builds wrapped terminal events', () => {
        expect(isWrappedTerminalEventType('task_complete')).toBe(true);
        expect(isWrappedTerminalEventType('agent_message')).toBe(false);

        expect(buildWrappedTerminalEvent({
            type: 'task_failed',
            thread: { id: 'thread-1' },
            turn: { id: 'turn-1' },
            message: 'boom'
        }, {
            thread_id: 'thread-1',
            turn_id: 'turn-1'
        })).toEqual({
            type: 'task_failed',
            thread_id: 'thread-1',
            turn_id: 'turn-1',
            error: 'boom'
        });

        expect(buildWrappedTerminalEvent({ type: 'task_complete' }, {})).toBeNull();
        expect(buildWrappedTerminalEvent({ type: 'agent_message' }, {})).toBeNull();
    });

    it('builds wrapped forwarded notifications', () => {
        expect(buildWrappedTextDeltaNotification({
            type: 'agent_message_delta',
            item_id: 'msg-1',
            delta: 'Hello'
        }, { turn_id: 'turn-1' })).toEqual({
            method: 'item/agentMessage/delta',
            params: {
                itemId: 'msg-1',
                delta: 'Hello',
                turn_id: 'turn-1'
            }
        });

        expect(buildWrappedTextDeltaNotification({
            type: 'exec_command_output_delta',
            call_id: 'cmd-1',
            stdout: 'ok'
        }, {})).toEqual({
            method: 'item/commandExecution/outputDelta',
            params: {
                itemId: 'cmd-1',
                delta: 'ok'
            }
        });

        expect(buildWrappedTextDeltaNotification({ type: 'agent_message_delta' }, {})).toBeNull();

        expect(buildWrappedReasoningSectionBreakNotification({
            type: 'agent_reasoning_section_break',
            item_id: 'r1',
            summary_index: 2
        }, { thread_id: 'thread-1' })).toEqual({
            method: 'item/reasoning/summaryPartAdded',
            params: {
                itemId: 'r1',
                thread_id: 'thread-1',
                summaryIndex: 2
            }
        });
    });

    it('builds wrapped item forwarded notifications', () => {
        expect(buildWrappedItemNotification({
            type: 'item_started',
            item: {
                id: 'cmd-1',
                type: 'commandExecution',
                command: 'pwd',
                thread: { id: 'child-thread' },
                turn: { id: 'child-turn' }
            }
        }, {
            thread_id: 'child-thread',
            turn_id: 'child-turn'
        })).toEqual({
            method: 'item/started',
            params: {
                thread_id: 'child-thread',
                turn_id: 'child-turn',
                item: {
                    id: 'cmd-1',
                    type: 'commandExecution',
                    command: 'pwd',
                    thread: { id: 'child-thread' },
                    turn: { id: 'child-turn' }
                },
                itemId: 'cmd-1',
                threadId: 'child-thread',
                turnId: 'child-turn'
            }
        });

        expect(buildWrappedItemNotification({ type: 'agent_message' }, {})).toBeNull();
    });

    it('keeps wrapped ignore event types table-driven', () => {
        expect(isIgnoredWrappedCodexEventType('agent_message')).toBe(true);
        expect(isIgnoredWrappedCodexEventType('agent_reasoning_delta')).toBe(true);
        expect(isIgnoredWrappedCodexEventType('mcp_startup_update')).toBe(true);
        expect(isIgnoredWrappedCodexEventType('item_completed')).toBe(false);
        expect(isIgnoredWrappedCodexEventType('task_failed')).toBe(false);
    });

    it('builds wrapped error events', () => {
        expect(buildWrappedErrorEvent({ message: 'fatal' })).toEqual({
            type: 'task_failed',
            error: 'fatal'
        });
        expect(buildWrappedErrorEvent({
            message: 'temporary',
            error: { willRetry: true }
        })).toBeNull();
        expect(buildWrappedErrorEvent({ type: 'error' })).toBeNull();
    });
});
