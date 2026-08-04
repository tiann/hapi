import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, PermissionRequest } from '@/agent/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { CopilotPermissionHandler, mapCopilotPermissionDecision } from './permissionHandler';

describe('mapCopilotPermissionDecision', () => {
    it('cancels an explicit denial when only an allow option is available', () => {
        const request: PermissionRequest = {
            id: 'permission-1',
            sessionId: 'session-1',
            toolCallId: 'tool-1',
            options: [{
                optionId: 'allow-once',
                name: 'Allow once',
                kind: 'allow_once'
            }]
        };

        expect(mapCopilotPermissionDecision(request, 'denied')).toEqual({
            outcome: 'cancelled'
        });
    });

    it('cancels an explicit approval when only a reject option is available', () => {
        const request: PermissionRequest = {
            id: 'permission-1',
            sessionId: 'session-1',
            toolCallId: 'tool-1',
            options: [{
                optionId: 'reject-once',
                name: 'Reject once',
                kind: 'reject_once'
            }]
        };

        expect(mapCopilotPermissionDecision(request, 'approved')).toEqual({
            outcome: 'cancelled'
        });
    });

    it('keeps Bash pending in read-only mode', () => {
        let onPermissionRequest: ((request: PermissionRequest) => void) | undefined;
        const updateAgentState = vi.fn();
        const backend = {
            onPermissionRequest: (handler: (request: PermissionRequest) => void) => {
                onPermissionRequest = handler;
            },
            respondToPermission: vi.fn()
        } as unknown as AgentBackend;
        const session = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState
        } as unknown as ApiSessionClient;

        new CopilotPermissionHandler(session, backend, () => 'read-only');
        onPermissionRequest?.({
            id: 'permission-1',
            sessionId: 'session-1',
            toolCallId: 'tool-1',
            title: 'Bash',
            options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }]
        });

        expect(backend.respondToPermission).not.toHaveBeenCalled();
        expect(updateAgentState).toHaveBeenCalledOnce();
    });
});
