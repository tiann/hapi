import { afterEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    initializeError: null as Error | null,
    snapshot: null as {
        availableModels: Array<{ modelId: string; name?: string }>
        currentModelId: string | null
    } | null
}));

vi.mock('@/cursor/utils/cursorAcpBackend', () => ({
    createCursorAcpBackend: vi.fn(() => ({
        initialize: vi.fn(async () => {
            if (harness.initializeError) {
                throw harness.initializeError;
            }
        }),
        newSession: vi.fn(async () => 'probe-session'),
        getSessionModelsMetadata: vi.fn(() => harness.snapshot),
        getConfigOptionByCategory: vi.fn(() => null),
        disconnect: vi.fn(async () => {})
    }))
}));

import { createCursorAcpBackend } from '@/cursor/utils/cursorAcpBackend';
import {
    cursorProbeResponseHasWireCatalog,
    runCursorAcpModelProbe
} from './cursorAcpModelProbe';

afterEach(() => {
    harness.initializeError = null;
    harness.snapshot = null;
    vi.mocked(createCursorAcpBackend).mockClear();
});

describe('runCursorAcpModelProbe', () => {
    test('returns wire catalog from ACP session/new snapshot', async () => {
        harness.snapshot = {
            availableModels: [
                { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                { modelId: 'composer-2.5[fast=false]', name: 'composer-2.5' }
            ],
            currentModelId: 'composer-2.5[fast=true]'
        };

        const result = await runCursorAcpModelProbe('/tmp/project');

        expect(result).toEqual({
            success: true,
            availableModels: harness.snapshot.availableModels,
            currentModelId: 'composer-2.5[fast=true]'
        });
        expect(cursorProbeResponseHasWireCatalog(result)).toBe(true);
        expect(createCursorAcpBackend).toHaveBeenCalledWith({ cwd: '/tmp/project' });
    });

    test('returns error when ACP initialize fails', async () => {
        harness.initializeError = new Error('agent acp unavailable');

        const result = await runCursorAcpModelProbe();

        expect(result.success).toBe(false);
        expect(result.error).toContain('agent acp unavailable');
    });
});
