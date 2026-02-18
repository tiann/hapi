import { describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@/api/types';
import type { PermissionMode } from '@hapi/protocol/types';
import {
    BasePermissionHandler,
    type CancelPendingRequestOptions,
    type PermissionCompletion,
    type PermissionHandlerClient
} from './BasePermissionHandler';

type TestResponse = {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: string;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

type RpcHandler = (params: TestResponse) => Promise<void> | void;
type AnyRpcHandler = (params: unknown) => unknown | Promise<unknown>;

function createClient(initialState: AgentState = {}): {
    client: PermissionHandlerClient & {
        rpcHandlerManager: PermissionHandlerClient['rpcHandlerManager'] & {
            registerHandlerSpy: ReturnType<typeof vi.fn>;
        };
    };
    getHandler: (method: string) => RpcHandler | undefined;
    getState: () => AgentState;
    updateAgentStateSpy: ReturnType<typeof vi.fn>;
} {
    const handlers = new Map<string, AnyRpcHandler>();
    let state = initialState;

    const registerHandlerSpy = vi.fn(<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: (params: TRequest) => Promise<TResponse> | TResponse
    ) => {
        handlers.set(method, handler as AnyRpcHandler);
    });

    const updateAgentStateSpy = vi.fn((updater: (state: AgentState) => AgentState) => {
        state = updater(state);
    });

    return {
        client: {
            rpcHandlerManager: {
                registerHandler: registerHandlerSpy as PermissionHandlerClient['rpcHandlerManager']['registerHandler'],
                registerHandlerSpy
            },
            updateAgentState: updateAgentStateSpy
        },
        getHandler: (method: string) => handlers.get(method) as RpcHandler | undefined,
        getState: () => state,
        updateAgentStateSpy
    };
}

class TestPermissionHandler extends BasePermissionHandler<TestResponse, string> {
    readonly missingResponses: TestResponse[] = [];
    readonly requestRegistrations: Array<{ id: string; toolName: string; input: unknown }> = [];
    readonly responses: TestResponse[] = [];

    constructor(client: PermissionHandlerClient) {
        super(client);
    }

    protected override async handlePermissionResponse(
        response: TestResponse,
        pending: { resolve: (value: string) => void; reject: (error: Error) => void; toolName: string }
    ): Promise<PermissionCompletion> {
        if (!response.approved) {
            pending.reject(new Error(response.reason ?? 'denied'));
            return {
                status: 'denied',
                reason: response.reason,
                mode: response.mode,
                decision: response.decision ?? 'denied'
            };
        }

        pending.resolve(`approved:${pending.toolName}`);
        return {
            status: 'approved',
            reason: response.reason,
            mode: response.mode,
            decision: response.decision ?? 'approved'
        };
    }

    protected override handleMissingPendingResponse(response: TestResponse): void {
        this.missingResponses.push(response);
    }

    protected override onRequestRegistered(id: string, toolName: string, input: unknown): void {
        this.requestRegistrations.push({ id, toolName, input });
    }

    protected override onResponseReceived(response: TestResponse): void {
        this.responses.push(response);
    }

    resolveDecision(
        mode: PermissionMode | undefined,
        toolName: string,
        toolCallId: string,
        overrides?: {
            alwaysToolNameHints?: string[];
            alwaysToolIdHints?: string[];
            writeToolNameHints?: string[];
        }
    ) {
        return this.resolveAutoApprovalDecision(mode, toolName, toolCallId, overrides);
    }

    addPending(
        id: string,
        toolName: string,
        input: unknown,
        handlers: { resolve: (value: string) => void; reject: (error: Error) => void }
    ): void {
        this.addPendingRequest(id, toolName, input, handlers);
    }

    addPendingPromise(id: string, toolName: string, input: unknown): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            this.addPendingRequest(id, toolName, input, { resolve, reject });
        });
    }

    finalize(id: string, completion: PermissionCompletion): void {
        this.finalizeRequest(id, completion);
    }

    cancel(options: CancelPendingRequestOptions): void {
        this.cancelPendingRequests(options);
    }

    pendingCount(): number {
        return this.pendingRequests.size;
    }
}

describe('BasePermissionHandler', () => {
    it('resolveAutoApprovalDecision handles modes and built-in hints', () => {
        const { client } = createClient();
        const handler = new TestPermissionHandler(client);

        expect(handler.resolveDecision('default', 'change_title', 'call-1')).toBe('approved');
        expect(handler.resolveDecision('yolo', 'change_title', 'call-1')).toBe('approved_for_session');
        expect(handler.resolveDecision('yolo', 'run_tool', 'call-2')).toBe('approved_for_session');
        expect(handler.resolveDecision('safe-yolo', 'run_tool', 'call-3')).toBe('approved');
        expect(handler.resolveDecision('read-only', 'ReadFile', 'call-4')).toBe('approved');
        expect(handler.resolveDecision('read-only', 'write_file', 'call-5')).toBeNull();
        expect(handler.resolveDecision('default', 'run_tool', 'call-6')).toBeNull();
    });

    it('resolveAutoApprovalDecision applies override hints', () => {
        const { client } = createClient();
        const handler = new TestPermissionHandler(client);

        expect(
            handler.resolveDecision('default', 'change_title', 'call-1', {
                alwaysToolNameHints: ['custom-only']
            })
        ).toBeNull();

        expect(
            handler.resolveDecision('default', 'tool', 'req-custom-id', {
                alwaysToolIdHints: ['custom-id']
            })
        ).toBe('approved');

        expect(
            handler.resolveDecision('read-only', 'writer_tool', 'call-2', {
                writeToolNameHints: ['writer_']
            })
        ).toBeNull();
    });

    it('tracks add/finalize lifecycle in agent state', () => {
        const { client, getState } = createClient({ requests: {}, completedRequests: {} });
        const handler = new TestPermissionHandler(client);

        const resolve = vi.fn();
        const reject = vi.fn();

        handler.addPending('req-1', 'write_file', { path: '/tmp/file' }, { resolve, reject });

        const afterAdd = getState();
        expect(handler.pendingCount()).toBe(1);
        expect(handler.requestRegistrations).toEqual([
            { id: 'req-1', toolName: 'write_file', input: { path: '/tmp/file' } }
        ]);
        expect(afterAdd.requests?.['req-1']?.tool).toBe('write_file');
        expect(typeof afterAdd.requests?.['req-1']?.createdAt).toBe('number');

        handler.finalize('req-1', {
            status: 'approved',
            reason: 'accepted',
            mode: 'safe-yolo',
            decision: 'approved',
            allowTools: ['Bash'],
            answers: { q1: ['yes'] }
        });

        const afterFinalize = getState();
        expect(afterFinalize.requests?.['req-1']).toBeUndefined();
        expect(afterFinalize.completedRequests?.['req-1']).toMatchObject({
            tool: 'write_file',
            status: 'approved',
            reason: 'accepted',
            mode: 'safe-yolo',
            decision: 'approved',
            allowTools: ['Bash'],
            answers: { q1: ['yes'] }
        });
        expect(typeof afterFinalize.completedRequests?.['req-1']?.completedAt).toBe('number');
        expect(resolve).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
    });

    it('cancels pending requests and rejects promises', async () => {
        const { client, getState } = createClient({ requests: {}, completedRequests: {} });
        const handler = new TestPermissionHandler(client);

        const rejectedErrors: string[] = [];
        handler.addPending('req-a', 'tool-a', {}, {
            resolve: () => {
                throw new Error('should not resolve req-a');
            },
            reject: (error: Error) => {
                rejectedErrors.push(error.message);
            }
        });
        handler.addPending('req-b', 'tool-b', {}, {
            resolve: () => {
                throw new Error('should not resolve req-b');
            },
            reject: (error: Error) => {
                rejectedErrors.push(error.message);
            }
        });

        handler.cancel({
            completedReason: 'session ended',
            rejectMessage: 'canceled by test',
            decision: 'abort'
        });

        expect(handler.pendingCount()).toBe(0);
        expect(rejectedErrors).toEqual(['canceled by test', 'canceled by test']);

        const state = getState();
        expect(state.requests).toEqual({});
        expect(state.completedRequests?.['req-a']).toMatchObject({
            status: 'canceled',
            reason: 'session ended',
            decision: 'abort'
        });
        expect(state.completedRequests?.['req-b']).toMatchObject({
            status: 'canceled',
            reason: 'session ended',
            decision: 'abort'
        });
    });

    it('wires the rpc permission handler to pending request resolution', async () => {
        const { client, getHandler, getState } = createClient({ requests: {}, completedRequests: {} });
        const handler = new TestPermissionHandler(client);

        const rpcHandler = getHandler('permission');
        expect(rpcHandler).toBeDefined();

        await rpcHandler?.({ id: 'missing', approved: true });
        expect(handler.missingResponses).toEqual([{ id: 'missing', approved: true }]);

        const pending = handler.addPendingPromise('req-rpc', 'tool-rpc', { a: 1 });
        await rpcHandler?.({
            id: 'req-rpc',
            approved: true,
            reason: 'ok',
            mode: 'safe-yolo',
            decision: 'approved'
        });

        await expect(pending).resolves.toBe('approved:tool-rpc');
        expect(handler.pendingCount()).toBe(0);
        expect(handler.responses).toEqual([
            {
                id: 'req-rpc',
                approved: true,
                reason: 'ok',
                mode: 'safe-yolo',
                decision: 'approved'
            }
        ]);

        const state = getState();
        expect(state.completedRequests?.['req-rpc']).toMatchObject({
            status: 'approved',
            reason: 'ok',
            mode: 'safe-yolo',
            decision: 'approved'
        });
    });
});
