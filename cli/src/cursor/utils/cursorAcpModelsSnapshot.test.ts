import { describe, expect, it } from 'vitest';
import { buildCursorModelsSnapshotFromAcp } from './cursorAcpModelsSnapshot';

describe('buildCursorModelsSnapshotFromAcp', () => {
    it('merges configOptions model variants over the shorter availableModels list', () => {
        const backend = {
            getSessionModelsMetadata: () => ({
                availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
                currentModelId: 'composer-2.5[fast=true]'
            }),
            getConfigOptionByCategory: (_sessionId: string, category: string) => {
                if (category !== 'model') return undefined;
                return {
                    id: 'model-opt',
                    currentValue: 'composer-2.5[fast=true]',
                    options: [
                        { value: 'composer-2.5[fast=true]', name: 'composer-2.5' },
                        { value: 'composer-2.5[fast=false]', name: 'composer-2.5' }
                    ]
                };
            }
        };

        const snapshot = buildCursorModelsSnapshotFromAcp(backend, 's1');

        expect(snapshot?.availableModels.map((entry) => entry.modelId).sort()).toEqual([
            'composer-2.5[fast=false]',
            'composer-2.5[fast=true]'
        ]);
        expect(snapshot?.currentModelId).toBe('composer-2.5[fast=true]');
    });

    it('uses configOptions alone when models metadata is missing', () => {
        const backend = {
            getSessionModelsMetadata: () => undefined,
            getConfigOptionByCategory: () => ({
                id: 'model-opt',
                currentValue: 'claude-opus-4-8[effort=high,fast=false]',
                options: [
                    { value: 'claude-opus-4-8[effort=high,fast=false]', name: 'Claude Opus 4.8' },
                    { value: 'claude-opus-4-8[effort=low,fast=false]', name: 'Claude Opus 4.8' }
                ]
            })
        };

        const snapshot = buildCursorModelsSnapshotFromAcp(backend, 's1');

        expect(snapshot?.availableModels).toHaveLength(2);
    });

    it('keeps parameterized model + fast options as bare bases without synthesizing wires', () => {
        const backend = {
            getSessionModelsMetadata: () => ({
                availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }],
                currentModelId: 'composer-2.5'
            }),
            getConfigOptionByCategory: (_sessionId: string, category: string) => {
                if (category === 'model') {
                    return {
                        id: 'model',
                        currentValue: 'composer-2.5',
                        options: [{ value: 'composer-2.5', name: 'Composer 2.5' }]
                    };
                }
                if (category === 'fast') {
                    return {
                        id: 'fast',
                        currentValue: 'false',
                        options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }]
                    };
                }
                return undefined;
            },
            getSessionConfigOptions: () => [
                {
                    id: 'model',
                    currentValue: 'composer-2.5',
                    options: [{ value: 'composer-2.5', name: 'Composer 2.5' }]
                },
                {
                    id: 'fast',
                    currentValue: 'false',
                    options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }]
                }
            ]
        };

        const snapshot = buildCursorModelsSnapshotFromAcp(backend, 's1');

        // `composer-2.5[fast=…]` is rejected by Cursor's `--model` whenever the wire
        // omits another parameter of the model, so only the bare base is advertised.
        expect(snapshot?.availableModels.map((entry) => entry.modelId)).toEqual(['composer-2.5']);
        expect(snapshot?.currentModelId).toBe('composer-2.5');
        expect(snapshot?.parameterized).toBe(true);
    });
});
