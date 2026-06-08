import { afterEach, describe, expect, test } from 'vitest';
import {
    readSharedCursorModelsCache,
    writeSharedCursorModelsCache,
    _resetSharedCursorModelsCacheForTests
} from './cursorModelsSharedCache';

afterEach(() => {
    _resetSharedCursorModelsCacheForTests();
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
});
