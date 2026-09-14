import { describe, expect, it, vi } from 'vitest';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import {
    applyCursorAcpModel,
    applyCursorAcpMode,
    isCursorAutoReviewMode,
    resolveCursorAcpWireId,
    resolveCursorModeAfterPlanApproval,
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

describe('resolveCursorModeAfterPlanApproval', () => {
    it('leaves plan/ask for default so Yes can execute the task', () => {
        expect(resolveCursorModeAfterPlanApproval('plan')).toBe('default');
        expect(resolveCursorModeAfterPlanApproval('ask')).toBe('default');
        expect(resolveCursorModeAfterPlanApproval(undefined)).toBe('default');
    });

    it('preserves executable modes (yolo, default, debug, autoReview)', () => {
        expect(resolveCursorModeAfterPlanApproval('yolo')).toBe('yolo');
        expect(resolveCursorModeAfterPlanApproval('default')).toBe('default');
        expect(resolveCursorModeAfterPlanApproval('debug')).toBe('debug');
        expect(resolveCursorModeAfterPlanApproval('autoReview')).toBe('autoReview');
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

    it('stores remapped catalog ids when a legacy wire base was upgraded', () => {
        expect(
            wireIdForCursorSessionState(
                'grok-4.5[fast=false]',
                'cursor-grok-4.5-medium'
            )
        ).toBe('cursor-grok-4.5-medium');
    });

    it('keeps spawn-safe bare/SKU requests instead of re-persisting ACP wires (#1430)', () => {
        expect(
            wireIdForCursorSessionState('composer-2.5', 'composer-2.5[fast=true]')
        ).toBe('composer-2.5');
        expect(
            wireIdForCursorSessionState('gpt-5.3-codex', 'gpt-5.3-codex[reasoning=medium,fast=false]')
        ).toBe('gpt-5.3-codex');
    });

    it('prefers spawn-safe bare/SKU resolved ids over bracketed requests (#1428)', () => {
        expect(
            wireIdForCursorSessionState('gpt-5.3-codex[fast=false]', 'gpt-5.3-codex')
        ).toBe('gpt-5.3-codex');
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

    it('prefers compatible option wires over bare metadata bases (#1430)', async () => {
        const setConfigOption = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'claude-opus-4-8' }],
                currentModelId: 'claude-opus-4-8'
            })),
            getConfigOptionByCategory: vi.fn(() => ({
                id: 'model-opt',
                options: [
                    { value: 'claude-opus-4-8[thinking=true,context=300k,effort=low,fast=false]' },
                    { value: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]' },
                ]
            }))
        });

        await expect(
            applyCursorAcpModel(backend, 's1', 'claude-opus-4-8[effort=high]')
        ).resolves.toEqual({
            applied: true,
            resolvedWireId: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]',
            requestedWireId: 'claude-opus-4-8[effort=high]'
        });
        expect(setConfigOption).toHaveBeenCalledWith(
            's1',
            'model-opt',
            'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]'
        );
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

    it('applies the requested effort over config options for variant sku requests (#1818)', async () => {
        const setConfigOption = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'claude-opus-4-8', name: 'Claude Opus 4.8' }],
                currentModelId: 'claude-opus-4-8'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'model') {
                    return { id: 'model', category: 'model', options: [{ value: 'claude-opus-4-8' }] };
                }
                if (category === 'fast') {
                    return { id: 'fast', category: 'fast', options: [{ value: 'false' }, { value: 'true' }] };
                }
                return undefined;
            }),
            getSessionConfigOptions: vi.fn(() => [
                { id: 'model', category: 'model', options: [{ value: 'claude-opus-4-8' }] },
                {
                    id: 'effort',
                    category: 'thought_level',
                    currentValue: 'high',
                    options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'xhigh' }]
                },
                { id: 'fast', category: 'model_config', options: [{ value: 'false' }, { value: 'true' }] }
            ])
        });

        await expect(applyCursorAcpModel(backend, 's1', 'claude-opus-4-8-low')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'claude-opus-4-8[fast=false,effort=low]',
            requestedWireId: 'claude-opus-4-8-low'
        });
        expect(setConfigOption).toHaveBeenNthCalledWith(1, 's1', 'model', 'claude-opus-4-8');
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'fast', 'false');
        expect(setConfigOption).toHaveBeenNthCalledWith(3, 's1', 'effort', 'low');
    });

    it('skips parameter axes the selected model does not expose (#1818)', async () => {
        let selected = 'grok-4.6';
        const fastOption = { id: 'fast', category: 'fast', options: [{ value: 'false' }, { value: 'true' }] };
        const modelOption = { id: 'model', category: 'model', options: [{ value: 'gemini-3-flash' }] };
        const setConfigOption = vi.fn(async (_sessionId: string, id: string, value: string) => {
            if (id === 'model') {
                selected = value;
            }
        });
        // Cursor drops fast/thought_level for a model that supports neither.
        const activeOptions = () => (selected === 'gemini-3-flash' ? [modelOption] : [modelOption, fastOption]);
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'gemini-3-flash' }],
                currentModelId: 'gemini-3-flash'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                activeOptions().find((option) => option.category === category)
            ),
            getSessionConfigOptions: vi.fn(() => activeOptions())
        });

        await expect(applyCursorAcpModel(backend, 's1', 'gemini-3-flash')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'gemini-3-flash'
        });
        expect(setConfigOption).toHaveBeenCalledTimes(1);
        expect(setConfigOption).toHaveBeenCalledWith('s1', 'model', 'gemini-3-flash');
    });

    it('maps aliased effort values onto the per-model option id (#1818)', async () => {
        const modelOption = { id: 'model', category: 'model', options: [{ value: 'gpt-5.5' }] };
        const backend = mockModelBackend({
            setConfigOption: vi.fn(async () => {}),
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'gpt-5.5' }],
                currentModelId: 'gpt-5.5'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'model') {
                    return modelOption;
                }
                // gpt-5.5 spells the top effort `extra-high` on the `reasoning` id.
                if (category === 'reasoning') {
                    return {
                        id: 'reasoning',
                        category: 'thought_level',
                        currentValue: 'medium',
                        options: [{ value: 'none' }, { value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'extra-high' }]
                    };
                }
                return undefined;
            }),
            getSessionConfigOptions: vi.fn(() => [modelOption, { id: 'reasoning', category: 'thought_level', options: [{ value: 'extra-high' }] }])
        });

        await expect(applyCursorAcpModel(backend, 's1', 'gpt-5.5-xhigh')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'gpt-5.5[reasoning=extra-high]'
        });
        expect(backend.setConfigOption).toHaveBeenNthCalledWith(1, 's1', 'model', 'gpt-5.5');
        expect(backend.setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'reasoning', 'extra-high');
    });

    it('leaves Claude thinking untouched while switching effort (#1818)', async () => {
        const setConfigOption = vi.fn(async () => {});
        const options = [
            { id: 'model', category: 'model', options: [{ value: 'claude-opus-4-8' }] },
            { id: 'thinking', category: 'thought_level', currentValue: 'true', options: [{ value: 'false' }, { value: 'true' }] },
            { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] }
        ];
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({ availableModels: [{ modelId: 'claude-opus-4-8' }], currentModelId: 'claude-opus-4-8' })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) => {
                if (category === 'model') {
                    return options[0];
                }
                // Both `thinking` and `effort` are thought_level: category lookup must not
                // pick the toggle when the requested axis is effort.
                return category === 'effort' ? options[2] : undefined;
            }),
            getSessionConfigOptions: vi.fn(() => options)
        });

        await expect(applyCursorAcpModel(backend, 's1', 'claude-opus-4-8-xhigh')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'claude-opus-4-8[effort=xhigh]'
        });
        expect(setConfigOption).toHaveBeenCalledTimes(2);
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'effort', 'xhigh');
    });

    it('applies effort on gemini models through the reasoning_effort option id (#1818)', async () => {
        const options = [
            { id: 'model', category: 'model', options: [{ value: 'gemini-3.8-flash' }] },
            { id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }
        ];
        const setConfigOption = vi.fn(async () => {});
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({ availableModels: [{ modelId: 'gemini-3.8-flash' }], currentModelId: 'gemini-3.8-flash' })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                category === 'model' ? options[0] : undefined
            ),
            getSessionConfigOptions: vi.fn(() => options)
        });

        await expect(applyCursorAcpModel(backend, 's1', 'gemini-3.8-flash-high')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'gemini-3.8-flash[reasoning_effort=high]'
        });
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'reasoning_effort', 'high');
    });

    it('resolves the advertised base for a legacy cursor- prefixed sku (#1818)', async () => {
        const setConfigOption = vi.fn(async () => {});
        const options = [
            { id: 'model', category: 'model', options: [{ value: 'grok-4.6' }] },
            { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] }
        ];
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({ availableModels: [{ modelId: 'grok-4.6' }], currentModelId: 'grok-4.6' })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                category === 'model' ? options[0] : undefined
            ),
            getSessionConfigOptions: vi.fn(() => options)
        });

        await expect(applyCursorAcpModel(backend, 's1', 'cursor-grok-4.6-high')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'grok-4.6[effort=high]',
            requestedWireId: 'cursor-grok-4.6-high'
        });
        // The `cursor-` family prefix must map onto the advertised `grok-4.6` base.
        expect(setConfigOption).toHaveBeenNthCalledWith(1, 's1', 'model', 'grok-4.6');
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'effort', 'high');
    });

    it('reads the new model effort option after the base switch (#1818)', async () => {
        // Cursor renames the effort axis across families: gpt-5.5 uses `reasoning`,
        // claude-opus-4-8 uses `effort`. The apply path must resolve against the
        // options advertised for the model it just selected, not the previous ones.
        let selected = 'gpt-5.5';
        const modelOption = { id: 'model', category: 'model', options: [{ value: 'gpt-5.5' }, { value: 'claude-opus-4-8' }] };
        const gptOptions = [modelOption, { id: 'reasoning', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] }];
        const claudeOptions = [modelOption, { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }, { value: 'xhigh' }] }];
        const activeOptions = () => (selected === 'gpt-5.5' ? gptOptions : claudeOptions);
        const setConfigOption = vi.fn(async (_sessionId: string, id: string, value: string) => {
            if (id === 'model') {
                selected = value;
            }
        });
        const backend = mockModelBackend({
            setConfigOption,
            getSessionModelsMetadata: vi.fn(() => ({
                availableModels: [{ modelId: 'claude-opus-4-8' }],
                currentModelId: 'claude-opus-4-8'
            })),
            getConfigOptionByCategory: vi.fn((_sessionId: string, category: string) =>
                activeOptions().find((option) => option.category === category)
            ),
            getSessionConfigOptions: vi.fn(() => activeOptions())
        });

        await expect(applyCursorAcpModel(backend, 's1', 'claude-opus-4-8-xhigh')).resolves.toMatchObject({
            applied: true,
            resolvedWireId: 'claude-opus-4-8[effort=xhigh]'
        });
        expect(setConfigOption).toHaveBeenNthCalledWith(1, 's1', 'model', 'claude-opus-4-8');
        expect(setConfigOption).toHaveBeenNthCalledWith(2, 's1', 'effort', 'xhigh');
        expect(setConfigOption).not.toHaveBeenCalledWith('s1', 'reasoning', expect.anything());
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

    it('maps partial hub wires onto the nearest full ACP config option wire (#1428)', () => {
        expect(resolveCursorAcpWireId('claude-opus-4-8[effort=high]', [
            { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=low,fast=false]' },
            { modelId: 'claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]' }
        ])).toBe('claude-opus-4-8[thinking=true,context=300k,effort=high,fast=false]');
    });
});
