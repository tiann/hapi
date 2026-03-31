import { describe, expect, it, vi } from 'vitest';
import type { McpServerElicitationRequestParams } from '../appServerTypes';
import { registerAppServerPermissionHandlers } from './appServerPermissionAdapter';

const harness = vi.hoisted(() => ({
    loggerDebug: vi.fn()
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: harness.loggerDebug
    }
}));

function createPermissionHandlerStub() {
    return {
        handleToolCall: vi.fn(async () => ({ decision: 'approved' }))
    };
}

function createClientStub() {
    const handlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();

    return {
        client: {
            registerRequestHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
                handlers.set(method, handler);
            }
        },
        handlers
    };
}

describe('registerAppServerPermissionHandlers', () => {
    it('registers the MCP elicitation app-server handler', () => {
        const { client, handlers } = createClientStub();

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: createPermissionHandlerStub() as never
        });

        expect(handlers.has('mcpServer/elicitation/request')).toBe(true);
    });

    it('cancels MCP elicitation requests when no handler is provided', async () => {
        const { client, handlers } = createClientStub();

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: createPermissionHandlerStub() as never
        });

        const handler = handlers.get('mcpServer/elicitation/request');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({})).resolves.toEqual({
            action: 'cancel',
            content: null
        });
        expect(harness.loggerDebug).toHaveBeenCalledWith(
            '[CodexAppServer] No MCP elicitation handler registered; cancelling request'
        );
    });

    it('returns the MCP elicitation result shape unchanged', async () => {
        const { client, handlers } = createClientStub();
        const request: McpServerElicitationRequestParams = {
            threadId: 'thread-1',
            turnId: 'turn-1',
            serverName: 'demo-server',
            request: {
                mode: 'form',
                message: 'Need input',
                requestedSchema: {
                    type: 'object'
                }
            }
        };
        const onMcpElicitationRequest = vi.fn(async () => ({
            action: 'accept' as const,
            content: {
                token: 'abc'
            }
        }));

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: createPermissionHandlerStub() as never,
            onMcpElicitationRequest
        });

        const handler = handlers.get('mcpServer/elicitation/request');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.(request)).resolves.toEqual({
            action: 'accept',
            content: {
                token: 'abc'
            }
        });
        expect(onMcpElicitationRequest).toHaveBeenCalledWith(request);
    });
});
