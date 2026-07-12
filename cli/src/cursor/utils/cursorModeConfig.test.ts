import { describe, expect, it, vi } from 'vitest';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import {
    applyCursorAcpModel,
    applyCursorAcpMode,
    isCursorAutoReviewMode,
    resolveCursorAcpWireId,
    toCursorAcpMode,
    wireIdForCursorSessionState
} from './cursorModeConfig';

function mockModelBackend(overrides: Record<string, unknown> = {}): AcpSdkBackend {
    return {
        pinSessionModelWireId: vi.fn(),
        ...overrides
    } as unknown as AcpSdkBackend;
}

describe('toCursorAcpMode', () => {
    it('maps HAPI cursor modes to Cursor ACP modes', () => {
        expect(toCursorAcpMode('default')).toBe('agent');
        expect(toCursorAcpMode('yolo')).toBe('agent');
        expect(toCursorAcpMode('autoReview')).toBe('agent');
        expect(toCursorAcpMode('plan')).toBe('plan');
        expect(toCursorAcpMode('ask')).toBe('ask');
        expect(toCursorAcpMode('debug')).toBe('debug');
        expect(isCursorAutoReviewMode('autoReview')).toBe(true);
        expect(isCursorAutoReviewMode('yolo')).toBe(false);
        expect(toCursorAcpMode(undefined)).toBe('agent');
    });
});

describe('applyCursorAcpMode', () => {
    it('prefers set_config_option for mode changes', async () => {
        const setConfigOption = vi.fn(async () => {});
        const setMode = vi.fn(async () => {});
        const backend = {
            setConfigOption,
            setMode,
            getConfigOptionByCategory: vi.fn(() => ({
                id: 'mode-opt',
                options: [{ value: 'debug' }, { value: 'plan' }, { value: 'agent' }]
            }))
        } as unknown as AcpSdkBackend;

        await applyCursorAcpMode(backend, 'session-1', 'debug');

        expect(setConfigOption).toHaveBeenCalledWith('session-1', 'mode-opt', 'debug');
        expect(setMode).not.toHaveBeenCalled();
    });

    it('maps default permission mode to agent when ACP exposes agent only', async () => {
        const setConfigOption = vi.fn(async () => {});
        const backend = {
            setConfigOption,
            setMode: vi.fn(),
            getConfigOptionByCategory: vi.fn(() => ({
                id: 'mode-opt',
                options: [{ value: 'agent' }, { value: 'plan' }, { value: 'debug' }]
            }))
        } as unknown as AcpSdkBackend;

        await applyCursorAcpMode(backend, 'session-1', 'default');

        expect(setConfigOption).toHaveBeenCalledWith('session-1', 'mode-opt', 'agent');
    });

    it('falls back to setMode when config option is unavailable', async () => {
        const setMode = vi.fn(async () => {});
        const backend = { setMode } as unknown as AcpSdkBackend;

        await applyCursorAcpMode(backend, 'session-1', 'plan');

        expect(setMode).toHaveBeenCalledWith('session-1', 'plan');
    });

    it('falls back to setMode when set_config_option throws', async () => {
        const setConfigOption = vi.fn(async () => {
            throw new Error('rejected');
        });
        const setMode = vi.fn(async () => {});
        const backend = {
            setConfigOption,
            setMode,
            getConfigOptionByCategory: vi.fn(() => ({
                id: 'mode-opt',
                options: [{ value: 'ask' }]
            }))
        } as unknown as AcpSdkBackend;

        await applyCursorAcpMode(backend, 'session-1', 'ask');

        expect(setMode).toHaveBeenCalledWith('session-1', 'ask');
    });

    it('swallows setMode errors', async () => {
        const setMode = vi.fn(async () => {
            throw new Error('method not found');
        });
        const backend = { setMode } as unknown as AcpSdkBackend;

        await expect(applyCursorAcpMode(backend, 'session-1', 'ask')).resolves.toBeUndefined();
    });
});

describe('wireIdForCursorSessionState', () => {
    it('keeps explicit variant wire ids from the user request', () => {
        expect(
            wireIdForCursorSessionState(
                'composer-2.5[fast=false]',
                'composer-2.5[fast=true]'
            )
        ).toBe('composer-2.5[fast=false]');
    });

    it('uses resolved wire id for base-only requests', () => {
        expect(
            wireIdForCursorSessionState('composer-2.5', 'composer-2.5[fast=true]')
        ).toBe('composer-2.5[fast=true]');
    });
});

describe('applyCursorAcpModel', () => {
    const metadata = {
        availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
        currentModelId: 'composer-2.5[fast=true]'
    };

    it('returns not applied when model id is empty', async () => {
        const setConfigOption = vi.fn();
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => metadata),
            getConfigOptionByCategory: vi.fn(() => ({ id: 'model-opt' }))
        });
        await expect(applyCursorAcpModel(backend, 's1', null)).resolves.toEqual({ applied: false });
        expect(setConfigOption).not.toHaveBeenCalled();
    });

    it('uses session/set_config_option for ACP wire ids (Zed-style)', async () => {
        const setConfigOption = vi.fn(async () => {});
        const setModel = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            setModel,
            getSessionModelsMetadata: vi.fn(() => metadata),
            getConfigOptionByCategory: vi.fn(() => ({ id: 'model-opt' }))
        });

        await expect(
            applyCursorAcpModel(backend, 's1', 'composer-2.5[fast=true]')
        ).resolves.toEqual({
            applied: true,
            resolvedWireId: 'composer-2.5[fast=true]',
            requestedWireId: 'composer-2.5[fast=true]'
        });
        expect(setConfigOption).toHaveBeenCalledWith('s1', 'model-opt', 'composer-2.5[fast=true]');
        expect(backend.pinSessionModelWireId).toHaveBeenCalledWith('s1', 'composer-2.5[fast=true]');
        expect(setModel).not.toHaveBeenCalled();
    });

    it('rejects ids not present in ACP configOptions', async () => {
        const setConfigOption = vi.fn();
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => metadata),
            getConfigOptionByCategory: vi.fn(() => ({ id: 'model-opt' }))
        });

        await expect(
            applyCursorAcpModel(backend, 's1', 'claude-opus-4-8[effort=high]')
        ).resolves.toEqual({ applied: false });
        expect(setConfigOption).not.toHaveBeenCalled();
    });

    it('resolves spawn wire id via config option list when metadata lists one variant', async () => {
        const setConfigOption = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            setModel: vi.fn(),
            getSessionModelsMetadata: vi.fn(() => metadata),
            getConfigOptionByCategory: vi.fn(() => ({
                id: 'model-opt',
                options: [
                    { value: 'composer-2.5[fast=true]' },
                    { value: 'composer-2.5[fast=false]' }
                ]
            }))
        });

        await expect(
            applyCursorAcpModel(backend, 's1', 'composer-2.5[fast=false]')
        ).resolves.toEqual({
            applied: true,
            resolvedWireId: 'composer-2.5[fast=false]',
            requestedWireId: 'composer-2.5[fast=false]'
        });
        expect(setConfigOption).toHaveBeenCalledWith('s1', 'model-opt', 'composer-2.5[fast=false]');
    });

    it('applies parameterized Cursor Composer fast=false for base CLI sku requests', async () => {
        const setConfigOption = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }],
                currentModelId: 'composer-2.5'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'model') {
                    return {
                        id: 'model',
                        category: 'model',
                        currentValue: 'composer-2.5',
                        options: [{ value: 'composer-2.5', name: 'Composer 2.5' }]
                    };
                }
                if (category === 'fast') {
                    return {
                        id: 'fast',
                        category: 'fast',
                        currentValue: 'true',
                        options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }]
                    };
                }
                return undefined;
            })
        });

        await expect(applyCursorAcpModel(backend, 's1', 'composer-2.5')).resolves.toEqual({
            applied: true,
            resolvedWireId: 'composer-2.5[fast=false]',
            requestedWireId: 'composer-2.5'
        });
        expect(setConfigOption).toHaveBeenNthCalledWith(1, 's1', 'model', 'composer-2.5');
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'fast', 'false');
        expect(backend.pinSessionModelWireId).toHaveBeenCalledWith('s1', 'composer-2.5[fast=false]');
    });

    it('applies parameterized Cursor Composer fast=true for -fast CLI sku requests', async () => {
        const setConfigOption = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }],
                currentModelId: 'composer-2.5'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'model') {
                    return { id: 'model', category: 'model', options: [{ value: 'composer-2.5' }] };
                }
                if (category === 'fast') {
                    return { id: 'fast', category: 'fast', options: [{ value: 'false' }, { value: 'true' }] };
                }
                return undefined;
            })
        });

        await expect(applyCursorAcpModel(backend, 's1', 'composer-2.5-fast')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'composer-2.5[fast=true]',
            requestedWireId: 'composer-2.5-fast'
        });
        expect(setConfigOption).toHaveBeenNthCalledWith(1, 's1', 'model', 'composer-2.5');
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'fast', 'true');
    });

    it('does not fall back to base-only model apply when parameterized fast update fails', async () => {
        const setConfigOption = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('fast update failed'));
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'composer-2.5', name: 'Composer 2.5' }],
                currentModelId: 'composer-2.5'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'model') {
                    return {
                        id: 'model',
                        category: 'model',
                        options: [{ value: 'composer-2.5', name: 'Composer 2.5' }]
                    };
                }
                if (category === 'fast') {
                    return {
                        id: 'fast',
                        category: 'fast',
                        options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }]
                    };
                }
                return undefined;
            })
        });

        await expect(applyCursorAcpModel(backend, 's1', 'composer-2.5')).resolves.toEqual({
            applied: false
        });
        expect(setConfigOption).toHaveBeenCalledTimes(2);
        expect(backend.pinSessionModelWireId).not.toHaveBeenCalled();
    });

    it('retries set_config_option once before failing apply', async () => {
        const setConfigOption = vi.fn()
            .mockRejectedValueOnce(new Error('transient'))
            .mockResolvedValueOnce(undefined);
        const setModel = vi.fn(async () => {
            throw new Error('should not reach set_model');
        });
        const backend = mockModelBackend({
            setConfigOption,
            setModel,
            getSessionModelsMetadata: vi.fn(() => metadata),
            getConfigOptionByCategory: vi.fn(() => ({ id: 'model-opt' }))
        });

        await expect(
            applyCursorAcpModel(backend, 's1', 'composer-2.5[fast=true]')
        ).resolves.toEqual({
            applied: true,
            resolvedWireId: 'composer-2.5[fast=true]',
            requestedWireId: 'composer-2.5[fast=true]'
        });
        expect(setConfigOption).toHaveBeenCalledTimes(2);
        expect(setModel).not.toHaveBeenCalled();
    });

    it('returns not applied when set_config_option is unavailable', async () => {
        const setModel = vi.fn(async () => {});
        const backend = mockModelBackend({
            setModel,
            getSessionModelsMetadata: vi.fn(() => metadata),
            getConfigOptionByCategory: vi.fn(() => undefined)
        });

        await expect(
            applyCursorAcpModel(backend, 's1', 'composer-2.5[fast=true]')
        ).resolves.toEqual({ applied: false });
        expect(setModel).not.toHaveBeenCalled();
    });
});

describe('resolveCursorAcpWireId', () => {
    const available = [
        { modelId: 'composer-2.5[fast=true]' },
        { modelId: 'composer-2.5[fast=false]' }
    ];

    it('returns exact wire id matches', () => {
        expect(resolveCursorAcpWireId('composer-2.5[fast=false]', available)).toBe(
            'composer-2.5[fast=false]'
        );
    });

    it('maps base-only CLI sku requests onto the sole ACP wire for that base', () => {
        expect(resolveCursorAcpWireId('composer-2.5', [{ modelId: 'composer-2.5[fast=true]' }])).toBe(
            'composer-2.5[fast=true]'
        );
    });

    it('maps legacy Cursor CLI fast aliases onto matching ACP wire ids', () => {
        expect(resolveCursorAcpWireId('composer-2.5-fast', available)).toBe(
            'composer-2.5[fast=true]'
        );
    });

    it('does not match partial ACP parameter requests against full config option wire ids', () => {
        expect(resolveCursorAcpWireId('claude-opus-4-8[effort=high]', [
            { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=low,fast=false]' },
            { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]' }
        ])).toBe(null);
    });
});
