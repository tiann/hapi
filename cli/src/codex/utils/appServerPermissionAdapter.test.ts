import { describe, expect, it, vi } from 'vitest';
import { registerAppServerPermissionHandlers } from './appServerPermissionAdapter';

type UserInputHandler = NonNullable<Parameters<typeof registerAppServerPermissionHandlers>[0]['onUserInputRequest']>;

function createClient() {
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
    it('forwards request_user_input answers through the callback', async () => {
        const { client, handlers } = createClient();
        const permissionHandler = {
            handleToolCall: vi.fn()
        };
        const onUserInputRequest: UserInputHandler = async ({ id, input }) => {
            expect(id).toBe('tool-123');
            expect(input).toEqual({
                itemId: 'tool-123',
                questions: [{ id: 'approve_nav', question: 'Approve app tool call?' }]
            });
            return {
                decision: 'accept',
                answers: {
                    approve_nav: {
                        answers: ['Allow']
                    }
                }
            };
        };

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never,
            onUserInputRequest: vi.fn(onUserInputRequest)
        });

        const handler = handlers.get('item/tool/requestUserInput');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({
            itemId: 'tool-123',
            questions: [{ id: 'approve_nav', question: 'Approve app tool call?' }]
        })).resolves.toEqual({
            decision: 'accept',
            answers: {
                approve_nav: {
                    answers: ['Allow']
                }
            }
        });
    });

    it('cancels request_user_input when no callback is registered', async () => {
        const { client, handlers } = createClient();
        const permissionHandler = {
            handleToolCall: vi.fn()
        };

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never
        });

        const handler = handlers.get('item/tool/requestUserInput');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({ itemId: 'tool-123' })).resolves.toEqual({
            decision: 'cancel'
        });
    });

    it('accepts MCP elicitation requests with schema defaults', async () => {
        const { client, handlers } = createClient();
        const permissionHandler = {
            handleToolCall: vi.fn()
        };

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never
        });

        const handler = handlers.get('mcpServer/elicitation/request');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({
            threadId: 'thread-1',
            turnId: 'turn-1',
            serverName: 'hapi',
            mode: 'form',
            message: 'Approve MCP tool call?',
            _meta: null,
            requestedSchema: {
                type: 'object',
                properties: {
                    approval: {
                        type: 'string',
                        enum: ['allow', 'deny']
                    },
                    remember: {
                        type: 'boolean',
                        default: false
                    }
                },
                required: ['approval', 'remember']
            }
        })).resolves.toEqual({
            action: 'accept',
            content: {
                approval: 'allow',
                remember: false
            },
            _meta: null
        });
    });

    it('cancels non-HAPI MCP elicitation requests', async () => {
        const { client, handlers } = createClient();
        const permissionHandler = {
            handleToolCall: vi.fn()
        };

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never
        });

        const handler = handlers.get('mcpServer/elicitation/request');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({
            threadId: 'thread-1',
            turnId: 'turn-1',
            serverName: 'external',
            mode: 'form',
            message: 'Collect data',
            _meta: null,
            requestedSchema: {
                type: 'object',
                properties: {},
            }
        })).resolves.toEqual({
            action: 'cancel',
            content: null,
            _meta: null
        });
    });
});
