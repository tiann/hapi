import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PiResponseEvent } from './types';

// Mock logger before importing anything that uses it
vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn()
    }
}));

// Mock session with minimal interface
function createMockSession() {
    return {
        sendSessionEvent: vi.fn(),
        sendAgentMessage: vi.fn(),
    };
}

type OnUpdate = (update: { model?: string | null; permissionMode?: string }) => void;

// Re-implement handleResponse as a standalone testable function
// This mirrors the logic in runPi.ts exactly
function handleResponse(
    response: PiResponseEvent,
    model: string | null,
    onUpdate: OnUpdate,
    session: ReturnType<typeof createMockSession>,
    state: { currentProvider: string | null }
): void {
    const { command, success } = response;

    if (!success) {
        const error = response.error ?? 'Unknown Pi error';
        session.sendSessionEvent({ type: 'message', message: error });
        return;
    }

    switch (command) {
        case 'get_state': {
            const data = response.data as Record<string, unknown> | undefined;
            if (data?.model && typeof data.model === 'object') {
                const modelObj = data.model as Record<string, unknown>;
                const newModel = (modelObj.modelId as string) ?? model;
                const provider = modelObj.provider;
                if (typeof provider === 'string' && provider.length > 0) {
                    state.currentProvider = provider;
                }
                onUpdate({ model: newModel });
            }
            break;
        }
        case 'set_model': {
            const data = response.data as Record<string, unknown> | undefined;
            if (data?.modelId) {
                onUpdate({ model: data.modelId as string });
            }
            if (data && typeof data.provider === 'string' && data.provider.length > 0) {
                state.currentProvider = data.provider;
            }
            break;
        }
        case 'new_session':
            break;
        case 'abort':
            break;
        case 'prompt':
            break;
        default:
            break;
    }
}

describe('handleResponse', () => {
    let session: ReturnType<typeof createMockSession>;
    let onUpdate: OnUpdate;
    let state: { currentProvider: string | null };

    beforeEach(() => {
        vi.clearAllMocks();
        session = createMockSession();
        onUpdate = vi.fn();
        state = { currentProvider: null };
    });

    it('should send error message on !success', () => {
        handleResponse(
            { type: 'response', command: 'prompt', success: false, error: 'Pi crashed' },
            null,
            onUpdate,
            session,
            state
        );
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Pi crashed'
        });
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should use default error message when error field is missing', () => {
        handleResponse(
            { type: 'response', command: 'prompt', success: false } as PiResponseEvent,
            null,
            onUpdate,
            session,
            state
        );
        expect(session.sendSessionEvent).toHaveBeenCalledWith({
            type: 'message',
            message: 'Unknown Pi error'
        });
    });

    it('should extract model from get_state response', () => {
        handleResponse(
            { type: 'response', command: 'get_state', success: true, data: { model: { modelId: 'gpt-4o' } } },
            null,
            onUpdate,
            session,
            state
        );
        expect(onUpdate).toHaveBeenCalledWith({ model: 'gpt-4o' });
    });

    it('should cache provider from get_state response so subsequent set_model can satisfy Pi two-arg requirement', () => {
        handleResponse(
            { type: 'response', command: 'get_state', success: true, data: { model: { modelId: 'gpt-4o', provider: 'openai' } } },
            null,
            onUpdate,
            session,
            state
        );
        expect(state.currentProvider).toBe('openai');
    });

    it('should not cache empty provider from get_state', () => {
        handleResponse(
            { type: 'response', command: 'get_state', success: true, data: { model: { modelId: 'gpt-4o', provider: '' } } },
            null,
            onUpdate,
            session,
            state
        );
        expect(state.currentProvider).toBeNull();
    });

    it('should keep current model when get_state has no model data', () => {
        handleResponse(
            { type: 'response', command: 'get_state', success: true, data: {} },
            'claude-3',
            onUpdate,
            session,
            state
        );
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should update model on set_model success', () => {
        handleResponse(
            { type: 'response', command: 'set_model', success: true, data: { modelId: 'gpt-4o' } },
            'claude-3',
            onUpdate,
            session,
            state
        );
        expect(onUpdate).toHaveBeenCalledWith({ model: 'gpt-4o' });
    });

    it('should refresh provider from set_model response when present', () => {
        handleResponse(
            { type: 'response', command: 'set_model', success: true, data: { modelId: 'gpt-4o', provider: 'openai' } },
            'claude-3',
            onUpdate,
            session,
            state
        );
        expect(state.currentProvider).toBe('openai');
    });

    it('should not update model when set_model data has no modelId', () => {
        handleResponse(
            { type: 'response', command: 'set_model', success: true, data: {} },
            'claude-3',
            onUpdate,
            session,
            state
        );
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should handle new_session response without errors', () => {
        expect(() =>
            handleResponse(
                { type: 'response', command: 'new_session', success: true },
                null,
                onUpdate,
                session,
                state
            )
        ).not.toThrow();
        expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should handle abort response without errors', () => {
        expect(() =>
            handleResponse(
                { type: 'response', command: 'abort', success: true },
                null,
                onUpdate,
                session,
                state
            )
        ).not.toThrow();
    });

    it('should handle prompt response without errors', () => {
        expect(() =>
            handleResponse(
                { type: 'response', command: 'prompt', success: true },
                null,
                onUpdate,
                session,
                state
            )
        ).not.toThrow();
    });

    it('should handle unknown command gracefully', () => {
        expect(() =>
            handleResponse(
                { type: 'response', command: 'unknown_cmd', success: true },
                null,
                onUpdate,
                session,
                state
            )
        ).not.toThrow();
    });
});
