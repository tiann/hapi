import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { _resetAgentCliGuardForTests } from '@/agent/backends/acp/agentCliGuard';

const testHome = join(tmpdir(), `hapi-cursor-models-lock-${process.pid}`);

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn()
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: spawnMock };
});

const acpProbeMock = vi.hoisted(() => ({
    runCursorAcpModelProbe: vi.fn()
}));

vi.mock('./cursorAcpModelProbe', () => ({
    runCursorAcpModelProbe: acpProbeMock.runCursorAcpModelProbe,
    cursorProbeResponseHasWireCatalog: (response: { success?: boolean; availableModels?: Array<{ modelId: string }> }) =>
        response.success === true
        && (response.availableModels ?? []).some((model) => model.modelId.includes('['))
}));

import {
    _resetCursorModelsCacheForTests,
    listCursorModels
} from './cursorModels';
import { _resetSharedCursorModelsCacheForTests } from './cursorModelsSharedCache';

describe('listCursorModels stale ACP lock', () => {
    const previousHome = process.env.HAPI_HOME;

    afterEach(() => {
        _resetAgentCliGuardForTests();
        _resetCursorModelsCacheForTests();
        _resetSharedCursorModelsCacheForTests();
        spawnMock.mockReset();
        acpProbeMock.runCursorAcpModelProbe.mockReset();
        if (previousHome === undefined) {
            delete process.env.HAPI_HOME;
        } else {
            process.env.HAPI_HOME = previousHome;
        }
    });

    test('runs cold ACP probe after clearing a stale cross-process lock', async () => {
        process.env.HAPI_HOME = testHome;
        const dir = join(testHome, 'locks', 'agent-acp-active');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pid'), '99999999');

        acpProbeMock.runCursorAcpModelProbe.mockResolvedValue({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        });

        const result = await listCursorModels();

        expect(existsSync(dir)).toBe(false);
        expect(acpProbeMock.runCursorAcpModelProbe).toHaveBeenCalled();
        expect(result.availableModels).toEqual([
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
        ]);
    });
});
