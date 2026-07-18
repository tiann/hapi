import {
    clearGoalInputSchema,
    getGoalInputSchema,
    setGoalInputSchema,
    type SetGoalInput
} from '@/claude/utils/hapiMcpTools';
import type {
    ThreadGoal,
    ThreadGoalClearParams,
    ThreadGoalClearResponse,
    ThreadGoalGetParams,
    ThreadGoalGetResponse,
    ThreadGoalSetParams,
    ThreadGoalSetResponse,
    ThreadGoalStatus
} from '../appServerTypes';
import type { HapiMcpToolRegistration, HapiMcpToolResult } from '@/claude/utils/startHappyServer';

type GoalRpcOptions = { signal?: AbortSignal };

export type CodexGoalClient = {
    getThreadGoal(params: ThreadGoalGetParams, options?: GoalRpcOptions): Promise<ThreadGoalGetResponse>;
    setThreadGoal(params: ThreadGoalSetParams, options?: GoalRpcOptions): Promise<ThreadGoalSetResponse>;
    clearThreadGoal(params: ThreadGoalClearParams, options?: GoalRpcOptions): Promise<ThreadGoalClearResponse>;
};

type GoalLike = Pick<ThreadGoal, 'objective'> & { status?: string | null };

const TERMINAL_GOAL_STATUSES = new Set([
    'complete',
    'usageLimited',
    'usage_limited',
    'budgetLimited',
    'budget_limited'
]);

function textResult(text: string, isError = false): HapiMcpToolResult {
    return {
        content: [{ type: 'text', text }],
        isError
    };
}

function isTerminalGoal(goal: { status?: unknown } | null | undefined): goal is GoalLike {
    return typeof goal?.status === 'string' && TERMINAL_GOAL_STATUSES.has(goal.status);
}

function formatGoal(goal: ThreadGoal): string {
    return `${goal.objective} (status: ${goal.status}, tokens used: ${goal.tokensUsed})`;
}

function buildSetGoalParams(args: {
    threadId: string;
    objective: string;
    status?: ThreadGoalStatus;
    tokenBudget?: number;
}): ThreadGoalSetParams {
    return {
        threadId: args.threadId,
        objective: args.objective,
        status: args.status ?? 'active',
        ...(typeof args.tokenBudget === 'number' ? { tokenBudget: args.tokenBudget } : {})
    };
}

export async function clearTerminalCodexGoal(
    client: Pick<CodexGoalClient, 'getThreadGoal' | 'clearThreadGoal'>,
    threadId: string,
    options: GoalRpcOptions = {}
): Promise<ThreadGoal | null> {
    const current = await client.getThreadGoal({ threadId }, { signal: options.signal });
    const goal = current.goal;
    if (!isTerminalGoal(goal)) {
        return null;
    }
    await client.clearThreadGoal({ threadId }, { signal: options.signal });
    return goal;
}

export async function setCodexThreadGoalReplacingTerminal(
    client: CodexGoalClient,
    args: {
        threadId: string;
        objective: string;
        status?: ThreadGoalStatus;
        tokenBudget?: number;
    },
    options: GoalRpcOptions = {}
): Promise<ThreadGoalSetResponse & { clearedGoal: ThreadGoal | null }> {
    let clearedGoal: ThreadGoal | null = null;
    try {
        clearedGoal = await clearTerminalCodexGoal(client, args.threadId, options);
    } catch {
        // Preserve legacy /goal behavior on older or partially available app-server builds:
        // the replacement preflight is best-effort, and the canonical set RPC below is
        // still the operation that should report the actionable error if goal RPCs are absent.
        clearedGoal = null;
    }
    const response = await client.setThreadGoal(buildSetGoalParams(args), { signal: options.signal });
    return {
        ...response,
        clearedGoal
    };
}

function resolveThreadId(getThreadId: () => string | null): string | null {
    const threadId = getThreadId();
    return typeof threadId === 'string' && threadId.length > 0 ? threadId : null;
}

export function createCodexGoalMcpTools(args: {
    client: CodexGoalClient;
    getThreadId: () => string | null;
    getSignal?: () => AbortSignal | undefined;
    runWithGoalNotificationSuppression?: <T>(action: () => Promise<T>) => Promise<T>;
}): HapiMcpToolRegistration[] {
    const requireThreadId = (): string | null => resolveThreadId(args.getThreadId);
    const currentSignal = (): AbortSignal | undefined => args.getSignal?.();
    const runGoalRpc = <T>(action: () => Promise<T>): Promise<T> => {
        return args.runWithGoalNotificationSuppression
            ? args.runWithGoalNotificationSuppression(action)
            : action();
    };

    return [
        {
            name: 'get_goal',
            description: 'Get the current HAPI/Codex conversation goal for this thread.',
            title: 'Get Goal',
            inputSchema: getGoalInputSchema,
            handler: async () => {
                const threadId = requireThreadId();
                if (!threadId) {
                    return textResult('No Codex thread is available to manage goals.', true);
                }
                try {
                    const response = await runGoalRpc(
                        () => args.client.getThreadGoal({ threadId }, { signal: currentSignal() })
                    );
                    return textResult(response.goal ? `Current goal: ${formatGoal(response.goal)}` : 'No goal is currently set');
                } catch (error) {
                    return textResult(`Failed to get goal: ${error instanceof Error ? error.message : String(error)}`, true);
                }
            }
        },
        {
            name: 'set_goal',
            description: [
                'Set or replace the current HAPI/Codex conversation goal for this thread.',
                'Use this instead of native create_goal when creating or replacing a goal.'
            ].join(' '),
            title: 'Set Goal',
            inputSchema: setGoalInputSchema,
            handler: async (rawArgs) => {
                const threadId = requireThreadId();
                if (!threadId) {
                    return textResult('No Codex thread is available to manage goals.', true);
                }
                const parsed = setGoalInputSchema.safeParse(rawArgs);
                if (!parsed.success) {
                    return textResult(`Failed to set goal: ${parsed.error.message}`, true);
                }
                const input: SetGoalInput = parsed.data;
                try {
                    const result = await runGoalRpc(
                        () => setCodexThreadGoalReplacingTerminal(args.client, {
                            threadId,
                            objective: input.objective,
                            status: input.status,
                            tokenBudget: input.tokenBudget
                        }, { signal: currentSignal() })
                    );
                    const cleared = result.clearedGoal
                        ? ` Replaced terminal prior goal: ${result.clearedGoal.objective}`
                        : '';
                    return textResult(`Goal set: ${result.goal.objective}${cleared}`);
                } catch (error) {
                    return textResult(`Failed to set goal: ${error instanceof Error ? error.message : String(error)}`, true);
                }
            }
        },
        {
            name: 'clear_goal',
            description: 'Clear the current HAPI/Codex conversation goal for this thread.',
            title: 'Clear Goal',
            inputSchema: clearGoalInputSchema,
            handler: async () => {
                const threadId = requireThreadId();
                if (!threadId) {
                    return textResult('No Codex thread is available to manage goals.', true);
                }
                try {
                    const response = await runGoalRpc(
                        () => args.client.clearThreadGoal({ threadId }, { signal: currentSignal() })
                    );
                    return textResult(response.cleared ? 'Goal cleared' : 'No goal is currently set');
                } catch (error) {
                    return textResult(`Failed to clear goal: ${error instanceof Error ? error.message : String(error)}`, true);
                }
            }
        }
    ];
}
