import { afterAll, afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    readSharedCursorModelsCache,
    writeSharedCursorModelsCache,
    _resetSharedCursorModelsCacheForTests
} from './cursorModelsSharedCache';

// Isolate the on-disk cursor-models cache to this file's own HAPI_HOME so
// parallel vitest workers don't race on the shared $HAPI_HOME/cache path
// (see heavygee/hapi#101).
const previousHapiHome = process.env.HAPI_HOME;
const testHapiHome = mkdtempSync(join(tmpdir(), 'hapi-cursor-models-shared-cache-'));
process.env.HAPI_HOME = testHapiHome;

afterEach(() => {
    _resetSharedCursorModelsCacheForTests();
});

// Remove the per-file temp root after the suite so runs don't leak dirs into
// the system temp dir (afterEach only clears the cache file inside it).
afterAll(() => {
    if (previousHapiHome === undefined) delete process.env.HAPI_HOME;
    else process.env.HAPI_HOME = previousHapiHome;
    rmSync(testHapiHome, { recursive: true, force: true });
});

describe('cursorModelsSharedCache', () => {
    test('round-trips a usable models response', () => {
        const payload = {
            success: true as const,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        };

        writeSharedCursorModelsCache(payload);

        expect(readSharedCursorModelsCache()).toEqual(payload);
    });

    test('ignores empty or invalid cache files', () => {
        writeSharedCursorModelsCache({ success: true, availableModels: [], currentModelId: null });
        expect(readSharedCursorModelsCache()).toBeNull();
    });

    test('round-trips cliModelSkus with wire catalog', () => {
        const payload = {
            success: true as const,
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cliModelSkus: [
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' }
            ]
        };

        writeSharedCursorModelsCache(payload);

        expect(readSharedCursorModelsCache()?.cliModelSkus).toEqual(payload.cliModelSkus);
    });

    test('ignores pre-versioned cache files that carry synthesized wire ids', () => {
        // v1 files carried `[fast=…]` wires Cursor rejects; a runner must re-probe
        // instead of serving them forever (listCursorModels trusts the cache).
        writeFileSync(
            join(testHapiHome, 'cache', 'cursor-models.json'),
            JSON.stringify({
                success: true,
                availableModels: [{ modelId: 'grok-4.6[fast=false]', name: 'Cursor Grok 4.6' }],
                currentModelId: 'grok-4.6[fast=false]'
            }),
            'utf8'
        );

        expect(readSharedCursorModelsCache()).toBeNull();
    });
});
