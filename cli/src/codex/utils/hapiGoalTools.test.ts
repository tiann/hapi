import { describe, expect, it, vi } from 'vitest';
import {
    clearTerminalCodexGoal,
    createCodexGoalMcpTools,
    setCodexThreadGoalReplacingTerminal
} from './hapiGoalTools';
import type { ThreadGoal } from '../appServerTypes';

function createGoal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
    return {
        threadId: 'thread-1',
        objective: 'old goal',
        status: 'complete',
        tokenBudget: null,
        tokensUsed: 42,
        timeUsedSeconds: 7,
        createdAt: 1,
        updatedAt: 2,
        ...overrides
    };
}

describe('hapiGoalTools', () => {
    it('clears terminal goals before replacing them with a new active goal', async () => {
        const client = {
            getThreadGoal: vi.fn(async () => ({ goal: createGoal({ status: 'complete' }) })),
            clearThreadGoal: vi.fn(async () => ({ cleared: true })),
            setThreadGoal: vi.fn(async () => ({ goal: createGoal({ objective: 'new goal', status: 'active' }) }))
        };

        const result = await setCodexThreadGoalReplacingTerminal(client, {
            threadId: 'thread-1',
            objective: 'new goal'
        });

        expect(result.clearedGoal?.objective).toBe('old goal');
        expect(client.getThreadGoal).toHaveBeenCalledWith({ threadId: 'thread-1' }, { signal: undefined });
        expect(client.clearThreadGoal).toHaveBeenCalledWith({ threadId: 'thread-1' }, { signal: undefined });
        expect(client.setThreadGoal).toHaveBeenCalledWith({
            threadId: 'thread-1',
            objective: 'new goal',
            status: 'active'
        }, { signal: undefined });
    });

    it('does not clear active goals before updating them', async () => {
        const client = {
            getThreadGoal: vi.fn(async () => ({ goal: createGoal({ status: 'active' }) })),
            clearThreadGoal: vi.fn(async () => ({ cleared: true })),
            setThreadGoal: vi.fn(async () => ({ goal: createGoal({ objective: 'new goal', status: 'active' }) }))
        };

        await setCodexThreadGoalReplacingTerminal(client, {
            threadId: 'thread-1',
            objective: 'new goal'
        });

        expect(client.clearThreadGoal).not.toHaveBeenCalled();
        expect(client.setThreadGoal).toHaveBeenCalledWith({
            threadId: 'thread-1',
            objective: 'new goal',
            status: 'active'
        }, { signal: undefined });
    });

    it('clears only terminal goals during pre-turn cleanup', async () => {
        const client = {
            getThreadGoal: vi.fn(async () => ({ goal: createGoal({ status: 'usageLimited' }) })),
            clearThreadGoal: vi.fn(async () => ({ cleared: true }))
        };

        const cleared = await clearTerminalCodexGoal(client, 'thread-1');

        expect(cleared?.status).toBe('usageLimited');
        expect(client.clearThreadGoal).toHaveBeenCalledWith({ threadId: 'thread-1' }, { signal: undefined });
    });

    it('exposes get/set/clear MCP goal tools bound to the current thread', async () => {
        const client = {
            getThreadGoal: vi.fn(async () => ({ goal: createGoal({ status: 'active', objective: 'current goal' }) })),
            clearThreadGoal: vi.fn(async () => ({ cleared: true })),
            setThreadGoal: vi.fn(async () => ({ goal: createGoal({ objective: 'new goal', status: 'active' }) }))
        };

        const tools = createCodexGoalMcpTools({
            client,
            getThreadId: () => 'thread-1'
        });

        expect(tools.map((tool) => tool.name)).toEqual(['get_goal', 'set_goal', 'clear_goal']);

        const setGoal = tools.find((tool) => tool.name === 'set_goal');
        expect(setGoal).toBeDefined();
        const response = await setGoal!.handler({ objective: 'new goal' });

        expect(response.isError).toBe(false);
        expect(response.content[0]?.text).toContain('Goal set: new goal');
        expect(client.setThreadGoal).toHaveBeenCalledWith({
            threadId: 'thread-1',
            objective: 'new goal',
            status: 'active'
        }, { signal: undefined });
    });

    it('runs MCP goal RPCs inside the launcher notification-suppression boundary', async () => {
        const client = {
            getThreadGoal: vi.fn(async () => ({ goal: null })),
            clearThreadGoal: vi.fn(async () => ({ cleared: true })),
            setThreadGoal: vi.fn(async () => ({ goal: createGoal({ objective: 'new goal', status: 'active' }) }))
        };
        const suppressionSpy = vi.fn();
        const runWithGoalNotificationSuppression = async <T,>(action: () => Promise<T>): Promise<T> => {
            suppressionSpy();
            return action();
        };

        const tools = createCodexGoalMcpTools({
            client,
            getThreadId: () => 'thread-1',
            runWithGoalNotificationSuppression
        });

        const setGoal = tools.find((tool) => tool.name === 'set_goal');
        await setGoal!.handler({ objective: 'new goal' });

        expect(suppressionSpy).toHaveBeenCalledTimes(1);
        expect(client.setThreadGoal).toHaveBeenCalled();
    });

    it('returns a tool error when no Codex thread is available', async () => {
        const tools = createCodexGoalMcpTools({
            client: {
                getThreadGoal: vi.fn(),
                clearThreadGoal: vi.fn(),
                setThreadGoal: vi.fn()
            },
            getThreadId: () => null
        });

        const response = await tools[0].handler({});

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain('No Codex thread is available');
    });
});
