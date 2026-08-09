import { afterEach, describe, expect, it } from 'vitest';
import {
    _resetSharedCursorModelsCacheForTests,
    writeSharedCursorModelsCache
} from '@/modules/common/cursorModelsSharedCache';
import {
    resolveCursorSpawnModel,
    tryRemapCursorSpawnModelFromConnectError,
    tryRemapCursorSpawnModelFromError
} from './cursorStaleModelRemap';

describe('cursorStaleModelRemap', () => {
    afterEach(() => {
        _resetSharedCursorModelsCacheForTests();
    });

    it('pre-spawns with a remapped model when shared cache has cursor-grok skus', () => {
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'cursor-grok-4.5-medium' }],
            currentModelId: 'cursor-grok-4.5-medium',
            cliModelSkus: [
                { modelId: 'cursor-grok-4.5-medium' },
                { modelId: 'cursor-grok-4.5-medium-fast' },
            ]
        });

        expect(resolveCursorSpawnModel('grok-4.5[fast=false]')).toBe('cursor-grok-4.5-medium');
    });

    it('remaps once from stderr Available models on model_not_found', () => {
        const remapped = tryRemapCursorSpawnModelFromError(
            'grok-4.5[fast=true]',
            'ACP process exited (code=1, signal=null). stderr: Cannot use this model: grok-4.5[fast=true]. Available models: auto, cursor-grok-4.5-high-fast'
        );
        expect(remapped).toBe('cursor-grok-4.5-high-fast');
    });

    it('remaps from stderr when Tip text follows on the same line', () => {
        const remapped = tryRemapCursorSpawnModelFromError(
            'grok-4.5[fast=false]',
            'Cannot use this model: grok-4.5[fast=false]. Available models: cursor-grok-4.5-medium Tip: agent --list-models'
        );
        expect(remapped).toBe('cursor-grok-4.5-medium');
    });

    it('falls back to the legacy wire when a cached SKU is rejected', () => {
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'cursor-grok-4.5-medium' }],
            currentModelId: 'cursor-grok-4.5-medium',
            cliModelSkus: [{ modelId: 'cursor-grok-4.5-medium' }],
        });

        const spawnModel = resolveCursorSpawnModel('grok-4.5[fast=false]');
        expect(spawnModel).toBe('cursor-grok-4.5-medium');

        const stderr = 'Cannot use this model: cursor-grok-4.5-medium. Available models: cursor-grok-4.5-high';
        expect(
            tryRemapCursorSpawnModelFromConnectError(
                spawnModel,
                'grok-4.5[fast=false]',
                stderr
            )
        ).toBe('cursor-grok-4.5-high');
    });

    it('pre-spawns bare base when cache only lists bare ACP catalog ids (#1428)', () => {
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [
                { modelId: 'gpt-5.3-codex' },
                { modelId: 'composer-2.5' },
            ],
            currentModelId: 'gpt-5.3-codex',
            cliModelSkus: [{ modelId: 'gpt-5.3-codex' }],
        });

        expect(resolveCursorSpawnModel('gpt-5.3-codex[fast=false]')).toBe('gpt-5.3-codex');
        expect(resolveCursorSpawnModel('composer-2.5[fast=true]')).toBe('composer-2.5');
    });

    it('remaps rejected bracket wires from stderr Available models (#1428)', () => {
        const remapped = tryRemapCursorSpawnModelFromError(
            'gpt-5.3-codex[fast=false]',
            'Cannot use this model: gpt-5.3-codex[fast=false]. Available models: auto, gpt-5.3-codex, gpt-5.3-codex-fast, composer-2.5'
        );
        expect(remapped).toBe('gpt-5.3-codex');
    });
});
