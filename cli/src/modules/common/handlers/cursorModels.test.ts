import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { _resetAgentCliGuardForTests } from '@/agent/backends/acp/agentCliGuard';
import {
    _resetCursorModelsCacheForTests,
    seedCursorModelsCache
} from '../cursorModels';
import {
    _resetSharedCursorModelsCacheForTests,
    writeSharedCursorModelsCache
} from '../cursorModelsSharedCache';
import { registerCursorModelHandlers } from './cursorModels';

async function createTempHapiHome(): Promise<string> {
    const path = join(tmpdir(), `hapi-cursor-rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(path, { recursive: true });
    return path;
}

describe('listCursorModels machine RPC handler', () => {
    let testHome: string;
    let savedHapiHome: string | undefined;
    let rpc: RpcHandlerManager;

    beforeEach(async () => {
        savedHapiHome = process.env.HAPI_HOME;
        testHome = await createTempHapiHome();
        process.env.HAPI_HOME = testHome;
        _resetCursorModelsCacheForTests();
        _resetSharedCursorModelsCacheForTests();
        _resetAgentCliGuardForTests();

        rpc = new RpcHandlerManager({ scopePrefix: 'machine-test' });
        registerCursorModelHandlers(rpc);
    });

    afterEach(async () => {
        _resetCursorModelsCacheForTests();
        _resetSharedCursorModelsCacheForTests();
        _resetAgentCliGuardForTests();
        if (savedHapiHome === undefined) {
            delete process.env.HAPI_HOME;
        } else {
            process.env.HAPI_HOME = savedHapiHome;
        }
        await rm(testHome, { recursive: true, force: true });
    });

    async function listViaRpc(): Promise<{
        success: boolean;
        availableModels?: Array<{ modelId: string; name?: string }>;
        currentModelId?: string | null;
    }> {
        const raw = await rpc.handleRequest({
            method: `machine-test:${RPC_METHODS.ListCursorModels}`,
            params: '{}'
        });
        return JSON.parse(raw) as {
            success: boolean;
            availableModels?: Array<{ modelId: string; name?: string }>;
            currentModelId?: string | null;
        };
    }

    it('returns shared on-disk ACP catalog while cross-process ACP lock is held', async () => {
        mkdirSync(join(testHome, 'locks', 'agent-acp-active'), { recursive: true });
        writeFileSync(join(testHome, 'locks', 'agent-acp-active', 'pid'), String(process.pid));

        seedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'stale-cli-sku' }],
            currentModelId: 'stale-cli-sku'
        });
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        });

        const result = await listViaRpc();

        expect(result).toEqual({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        });
    });

    it('returns empty list when ACP lock is held but no shared cache exists yet', async () => {
        mkdirSync(join(testHome, 'locks', 'agent-acp-active'), { recursive: true });
        writeFileSync(join(testHome, 'locks', 'agent-acp-active', 'pid'), String(process.pid));

        const result = await listViaRpc();

        expect(result).toEqual({
            success: true,
            availableModels: [],
            currentModelId: null
        });
    });
});
