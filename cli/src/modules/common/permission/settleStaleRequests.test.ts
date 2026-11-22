import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AgentState } from '@/api/types';
import type { AgentBackend } from '@/agent/types';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import { CopilotPermissionHandler } from '@/copilot/utils/permissionHandler';
import { GrokPermissionHandler } from '@/grok/utils/permissionHandler';
import { OpencodePermissionHandler } from '@/opencode/utils/permissionHandler';
import { AcpPermissionHandler } from './AcpPermissionHandler';
import { STALE_REQUEST_REASON } from './settleStaleRequests';

function storedState(): AgentState {
    return {
        requests: {
            'question:0#3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b': { tool: 'AskUserQuestion', toolCallId: 'question:0#3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b', arguments: {}, createdAt: 1 },
            // Legacy plain id from before lifetime ids: equally dead.
            'shell:0': { tool: 'Bash', arguments: {}, createdAt: 2 },
            live: { tool: 'Bash', arguments: {}, createdAt: 3 }
        },
        completedRequests: {}
    } as unknown as AgentState;
}

function makeSession(): { session: ApiSessionClient; state: () => AgentState } {
    let state = storedState();
    return {
        state: () => state,
        session: {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateAgentState: (update: (current: AgentState) => AgentState) => { state = update(state); },
            getAgentStateSnapshot: () => state
        } as unknown as ApiSessionClient
    };
}

function makeBackend(): AgentBackend {
    return {
        onPermissionRequest: vi.fn(),
        onFormElicitation: vi.fn(),
        respondToPermission: vi.fn(),
        hasLiveRequest: (id: string) => id === 'live'
    } as unknown as AgentBackend;
}

describe('ACP permission writers settle requests of the previous agent process on bind', () => {
    const writers: Array<[string, (session: ApiSessionClient, backend: AgentBackend) => unknown]> = [
        ['PermissionAdapter (generic ACP, Cursor)', (session, backend) => new PermissionAdapter(session, backend, () => 'default')],
        ['AcpPermissionHandler (agy, dsh, Kimi)', (session, backend) => new AcpPermissionHandler(session, backend, () => 'default')],
        ['OpencodePermissionHandler', (session, backend) => new OpencodePermissionHandler(session, backend, () => 'default')],
        ['GrokPermissionHandler', (session, backend) => new GrokPermissionHandler(session, backend, () => 'default')],
        ['CopilotPermissionHandler', (session, backend) => new CopilotPermissionHandler(session, backend, () => 'default')]
    ];

    it.each(writers)('%s', (_name, create) => {
        const { session, state } = makeSession();
        create(session, makeBackend());

        expect(Object.keys(state().requests ?? {})).toEqual(['live']);
        expect(state().completedRequests).toMatchObject({
            'question:0#3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b': { status: 'canceled', reason: STALE_REQUEST_REASON, toolCallId: 'question:0#3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b' },
            'shell:0': { status: 'canceled', reason: STALE_REQUEST_REASON }
        });
    });

    it('leaves stored requests alone for a backend that cannot tell live requests', () => {
        const { session, state } = makeSession();
        const backend = { ...makeBackend(), hasLiveRequest: undefined } as unknown as AgentBackend;
        new AcpPermissionHandler(session, backend, () => 'default');
        expect(Object.keys(state().requests ?? {})).toHaveLength(3);
    });
});
