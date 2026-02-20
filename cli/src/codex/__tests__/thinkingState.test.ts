import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppServerEventConverter } from '../utils/appServerEventConverter';

const THINKING_CLEAR_GRACE_MS = 3_000;
const WORK_START_EVENTS = new Set([
    'task_started',
    'exec_command_begin',
    'exec_approval_request',
    'patch_apply_begin',
    'mcp_tool_call_begin',
    'web_search_begin',
    'item_activity'
]);
const WORK_START_EVENT_TYPES = Array.from(WORK_START_EVENTS);

type ThinkingTracker = {
    thinking: boolean;
    turnInFlight: boolean;
    useAppServer: boolean;
    thinkingClearTimer: ReturnType<typeof setTimeout> | null;
    changes: boolean[];
};

function createThinkingTracker(useAppServer: boolean): ThinkingTracker {
    return {
        thinking: false,
        turnInFlight: false,
        useAppServer,
        thinkingClearTimer: null,
        changes: []
    };
}

function onThinkingChange(tracker: ThinkingTracker, value: boolean) {
    tracker.thinking = value;
    tracker.changes.push(value);
}

function clearThinkingClearTimer(tracker: ThinkingTracker) {
    if (!tracker.thinkingClearTimer) {
        return;
    }

    clearTimeout(tracker.thinkingClearTimer);
    tracker.thinkingClearTimer = null;
}

function startThinkingClearGrace(tracker: ThinkingTracker) {
    clearThinkingClearTimer(tracker);
    tracker.thinkingClearTimer = setTimeout(() => {
        tracker.thinkingClearTimer = null;
        if (tracker.thinking) {
            onThinkingChange(tracker, false);
        }
    }, THINKING_CLEAR_GRACE_MS);
}

function handleCodexEvent(tracker: ThinkingTracker, msgType: string) {
    if (tracker.useAppServer && WORK_START_EVENTS.has(msgType)) {
        clearThinkingClearTimer(tracker);
        if (!tracker.thinking) {
            onThinkingChange(tracker, true);
        }
    }

    if (msgType === 'task_started' && tracker.useAppServer) {
        tracker.turnInFlight = true;
    }

    if (msgType === 'task_complete') {
        if (tracker.useAppServer) {
            tracker.turnInFlight = false;
            startThinkingClearGrace(tracker);
        } else if (tracker.thinking) {
            onThinkingChange(tracker, false);
        }
        return;
    }

    if (msgType === 'turn_aborted' || msgType === 'task_failed') {
        if (tracker.useAppServer) {
            tracker.turnInFlight = false;
        }
        clearThinkingClearTimer(tracker);
        if (tracker.thinking) {
            onThinkingChange(tracker, false);
        }
    }
}

function simulateMessageSent(tracker: ThinkingTracker) {
    clearThinkingClearTimer(tracker);
    onThinkingChange(tracker, true);
}

function simulateStartTurn(tracker: ThinkingTracker) {
    if (tracker.useAppServer) {
        tracker.turnInFlight = true;
    }
}

function simulateFinallyBlock(tracker: ThinkingTracker) {
    const shouldClearThinking = !tracker.useAppServer
        || (!tracker.turnInFlight && !tracker.thinkingClearTimer);
    if (shouldClearThinking) {
        onThinkingChange(tracker, false);
    }
}

function simulateAbort(tracker: ThinkingTracker) {
    clearThinkingClearTimer(tracker);
    onThinkingChange(tracker, false);
}

function simulateAbortFullSequence(tracker: ThinkingTracker) {
    simulateAbort(tracker);
    if (tracker.useAppServer) {
        tracker.turnInFlight = false;
    }
    simulateFinallyBlock(tracker);
}

function simulateIsolatedCommand(tracker: ThinkingTracker) {
    tracker.turnInFlight = false;
    clearThinkingClearTimer(tracker);
    onThinkingChange(tracker, false);
}

function simulateLoopExit(tracker: ThinkingTracker) {
    clearThinkingClearTimer(tracker);
    if (tracker.thinking) {
        onThinkingChange(tracker, false);
    }
}

function handleConvertedNotifications(
    tracker: ThinkingTracker,
    converter: AppServerEventConverter,
    method: string,
    params: unknown
) {
    const events = converter.handleNotification(method, params);
    for (const event of events) {
        const msgType = typeof event.type === 'string' ? event.type : '';
        if (msgType) {
            handleCodexEvent(tracker, msgType);
        }
    }
}

describe('Codex thinking state lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('app-server path', () => {
        it('recovers thinking on work-start activity when currently false', () => {
            const t = createThinkingTracker(true);

            handleCodexEvent(t, 'exec_command_begin');

            expect(t.thinking).toBe(true);
            expect(t.changes).toEqual([true]);
        });

        it('recovers thinking on item_activity when currently false', () => {
            const t = createThinkingTracker(true);

            handleCodexEvent(t, 'item_activity');

            expect(t.thinking).toBe(true);
            expect(t.changes).toEqual([true]);
        });

        it('does not recover thinking on output/status events', () => {
            const t = createThinkingTracker(true);

            handleCodexEvent(t, 'agent_message');
            handleCodexEvent(t, 'agent_reasoning');
            handleCodexEvent(t, 'token_count');

            expect(t.thinking).toBe(false);
            expect(t.changes).toEqual([]);
        });

        it('keeps thinking during task_complete grace and clears after 3s with no follow-up', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            simulateFinallyBlock(t);

            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);
            expect(t.turnInFlight).toBe(false);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS - 1);
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(1);
            expect(t.thinking).toBe(false);
        });

        it('cancels grace timer when follow-up work starts within grace window', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(1_000);
            handleCodexEvent(t, 'task_started');
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(true);

            handleCodexEvent(t, 'task_complete');
            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS);
            expect(t.thinking).toBe(false);
        });

        it.each(WORK_START_EVENT_TYPES)('cancels grace timer on %s', (eventType) => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(1_000);
            handleCodexEvent(t, eventType);
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(true);

            handleCodexEvent(t, 'task_complete');
            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS);
            expect(t.thinking).toBe(false);
        });

        it('converter item/started -> launcher item_activity cancels grace timer', () => {
            const t = createThinkingTracker(true);
            const converter = new AppServerEventConverter();

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(1_000);
            handleConvertedNotifications(t, converter, 'item/started', {
                item: { id: 'mcp-1', type: 'mcpToolCall' }
            });
            expect(t.thinking).toBe(true);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(true);

            handleCodexEvent(t, 'task_complete');
            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS);
            expect(t.thinking).toBe(false);
        });

        it('clears thinking immediately on turn_aborted', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            handleCodexEvent(t, 'turn_aborted');
            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(false);
        });

        it('clears thinking immediately on task_failed', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            handleCodexEvent(t, 'task_failed');
            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(false);
        });

        it('abort clears thinking immediately and cancels pending grace timer', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            simulateAbortFullSequence(t);
            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(false);
        });

        it('/new and /clear style isolated command clears thinking immediately and cancels grace', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            simulateIsolatedCommand(t);
            expect(t.thinking).toBe(false);
            expect(t.turnInFlight).toBe(false);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(false);
        });

        it('single-turn flow still clears thinking after grace when no autonomous follow-up', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            simulateFinallyBlock(t);
            handleCodexEvent(t, 'task_started');
            handleCodexEvent(t, 'task_complete');

            expect(t.thinking).toBe(true);
            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS);
            expect(t.thinking).toBe(false);
        });

        it('loop exit clears pending timer and forces thinking=false', () => {
            const t = createThinkingTracker(true);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');
            expect(t.thinking).toBe(true);

            simulateLoopExit(t);
            expect(t.thinking).toBe(false);

            vi.advanceTimersByTime(THINKING_CLEAR_GRACE_MS + 10);
            expect(t.thinking).toBe(false);
        });
    });

    describe('MCP path', () => {
        it('keeps existing immediate clear behavior on task_complete', () => {
            const t = createThinkingTracker(false);

            simulateMessageSent(t);
            simulateStartTurn(t);
            handleCodexEvent(t, 'task_complete');

            expect(t.thinking).toBe(false);
        });

        it('finally block still clears thinking immediately for MCP path', () => {
            const t = createThinkingTracker(false);

            simulateMessageSent(t);
            expect(t.thinking).toBe(true);

            simulateFinallyBlock(t);
            expect(t.thinking).toBe(false);
        });
    });
});
