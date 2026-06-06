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
});
