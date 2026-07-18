import { describe, expect, it } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import type { Machine } from './types';
import type { SpawnSessionOptions } from '../modules/common/rpcTypes';

function createMachine(): Machine {
    return {
        id: 'machine-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            host: 'localhost',
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            homeDir: '/Users/test',
            happyHomeDir: '/Users/test/.hapi',
            happyLibDir: '/app/hapi'
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0
    };
}

describe('ApiMachineClient service tier RPC', () => {
    it('passes serviceTier from spawn-happy-session RPC into spawnSession options', async () => {
        const client = new ApiMachineClient('token', createMachine());
        let capturedOptions: SpawnSessionOptions | undefined;
        client.setRPCHandlers({
            spawnSession: async (options) => {
                capturedOptions = options;
                return { type: 'success', sessionId: 'session-1' };
            },
            querySpawnSession: async (spawnRequestId) => ({ type: 'pending', spawnRequestId }),
            stopSession: () => true,
            requestShutdown: () => {}
        });

        const response = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:spawn-happy-session',
            params: JSON.stringify({
                spawnRequestId: '11111111-1111-4111-8111-111111111111',
                directory: '/tmp/project',
                agent: 'codex',
                serviceTier: 'fast'
            })
        });

        expect(JSON.parse(response)).toEqual({ type: 'success', sessionId: 'session-1' });
        expect(capturedOptions?.serviceTier).toBe('fast');
        expect(capturedOptions?.spawnRequestId).toBe('11111111-1111-4111-8111-111111111111');

        const pendingResponse = await (client as any).rpcHandlerManager.handleRequest({
            method: 'machine-1:query-happy-session-spawn',
            params: JSON.stringify({
                spawnRequestId: '11111111-1111-4111-8111-111111111111'
            })
        });
        expect(JSON.parse(pendingResponse)).toEqual({
            type: 'pending',
            spawnRequestId: '11111111-1111-4111-8111-111111111111'
        });
    });
});
