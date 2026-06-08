import { afterEach, describe, expect, test, vi } from 'vitest'
import { setCursorAcpModelsSnapshot } from '@/cursor/utils/cursorAcpModelsBridge'

const { spawnMock } = vi.hoisted(() => ({
    spawnMock: vi.fn()
}));

vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return { ...actual, spawn: spawnMock };
});

vi.mock('@/agent/backends/acp/agentCliGuard', () => ({
    isAgentAcpTransportActive: vi.fn(() => false),
    _resetAgentCliGuardForTests: vi.fn()
}));

const acpProbeMock = vi.hoisted(() => ({
    runCursorAcpModelProbe: vi.fn()
}));

vi.mock('./cursorAcpModelProbe', () => ({
    runCursorAcpModelProbe: acpProbeMock.runCursorAcpModelProbe,
    cursorProbeResponseHasWireCatalog: (response: { success?: boolean; availableModels?: Array<{ modelId: string }> }) =>
        response.success === true
        && (response.availableModels ?? []).some((model) => model.modelId.includes('['))
}));

import { isAgentAcpTransportActive } from '@/agent/backends/acp/agentCliGuard';
import {
    readSharedCursorModelsCache,
    writeSharedCursorModelsCache,
    _resetSharedCursorModelsCacheForTests
} from './cursorModelsSharedCache';
import {
    _resetCursorModelsCacheForTests,
    buildCursorModelsSeedPayload,
    listCursorModels,
    parseCursorModelsOutput,
    seedCursorModelsCache
} from './cursorModels';

afterEach(() => {
    _resetCursorModelsCacheForTests()
    _resetSharedCursorModelsCacheForTests()
    setCursorAcpModelsSnapshot(null)
    vi.mocked(isAgentAcpTransportActive).mockReturnValue(false)
    spawnMock.mockReset()
    acpProbeMock.runCursorAcpModelProbe.mockReset()
})

describe('buildCursorModelsSeedPayload', () => {
    test('inherits cliModelSkus from shared cache when ACP snapshot has none', () => {
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cliModelSkus: [
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
                { modelId: 'gpt-5.5-high', name: 'GPT-5.5 High' }
            ]
        })

        const seeded = buildCursorModelsSeedPayload(
            {
                availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
                currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
            },
            readSharedCursorModelsCache()
        )

        expect(seeded.cliModelSkus?.map((row) => row.modelId)).toEqual([
            'gpt-5.5-medium',
            'gpt-5.5-high'
        ])
    })
})

describe('parseCursorModelsOutput', () => {
    test('parses Cursor agent model list output', () => {
        const result = parseCursorModelsOutput(`
Available models

auto - Auto
composer-2.5 - Composer 2.5 (current)
composer-2.5-fast - Composer 2.5 Fast (default)
gpt-5.5-high-fast - GPT-5.5 High Fast

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`)

        expect(result).toEqual({
            availableModels: [
                { modelId: 'auto', name: 'Auto' },
                { modelId: 'composer-2.5', name: 'Composer 2.5' },
                { modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' },
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
            ],
            currentModelId: 'composer-2.5'
        })
    })

    test('uses default as current when Cursor output has no current marker', () => {
        const result = parseCursorModelsOutput(`
Available models
composer-2.5-fast - Composer 2.5 Fast (default)
composer-2.5 - Composer 2.5
`)

        expect(result.currentModelId).toBe('composer-2.5-fast')
    })
})

describe('listCursorModels', () => {
    test('does not spawn agent --list-models while ACP transport is active', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        })

        const result = await listCursorModels()

        expect(result).toEqual({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        })
        expect(spawnMock).not.toHaveBeenCalled()
    })

    test('returns empty list while ACP is active but no snapshot is seeded yet', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)

        const result = await listCursorModels()

        expect(result).toEqual({
            success: true,
            availableModels: [],
            currentModelId: null
        })
        expect(spawnMock).not.toHaveBeenCalled()
    })

    test('prefers shared on-disk cache over stale in-memory cache while ACP lock is active', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)
        seedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'stale-cli-sku' }],
            currentModelId: 'stale-cli-sku'
        })
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        })

        const result = await listCursorModels()

        expect(result.availableModels).toEqual([
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
        ])
        expect(spawnMock).not.toHaveBeenCalled()
    })

    test('reads shared on-disk cache while ACP lock is active in another process', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        })

        const result = await listCursorModels()

        expect(result.availableModels).toEqual([
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
        ])
        expect(spawnMock).not.toHaveBeenCalled()
        expect(readSharedCursorModelsCache()?.currentModelId).toBe('composer-2.5[fast=true]')
    })

    test('unions partial response cliModelSkus with fuller shared cache while lock is active', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)
        setCursorAcpModelsSnapshot({
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cliModelSkus: [
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' }
            ]
        } as never)
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cliModelSkus: [
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' },
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
                { modelId: 'gpt-5.5-high', name: 'GPT-5.5 High' }
            ]
        })

        const result = await listCursorModels()

        expect(result.cliModelSkus?.map((row) => row.modelId)).toEqual([
            'gpt-5.5-high-fast',
            'gpt-5.5-low',
            'gpt-5.5-medium',
            'gpt-5.5-high'
        ])
        expect(spawnMock).not.toHaveBeenCalled()
    })

    test('enriches live ACP snapshot with fuller shared cliModelSkus while lock is active', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)
        setCursorAcpModelsSnapshot({
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]'
        })
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cliModelSkus: [
                { modelId: 'gpt-5.5-high-fast', name: 'GPT-5.5 High Fast' },
                { modelId: 'gpt-5.5-low', name: 'GPT-5.5 1M Low' },
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' },
                { modelId: 'gpt-5.5-high', name: 'GPT-5.5 High' }
            ]
        })

        const result = await listCursorModels()

        expect(result.cliModelSkus?.map((row) => row.modelId)).toEqual([
            'gpt-5.5-high-fast',
            'gpt-5.5-low',
            'gpt-5.5-medium',
            'gpt-5.5-high'
        ])
        expect(spawnMock).not.toHaveBeenCalled()
    })

    test('unions shared partial cliModelSkus with probe results when lock is inactive', async () => {
        writeSharedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'gpt-5.5' }],
            currentModelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            cliModelSkus: [
                { modelId: 'gpt-5.5-medium', name: 'GPT-5.5 1M' }
            ]
        })
        spawnMock.mockImplementation(() => ({
            stdout: {
                on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
                    if (event === 'data') {
                        handler(Buffer.from(
                            'gpt-5.5-high-fast - GPT-5.5 High Fast\n'
                            + 'gpt-5.5-high - GPT-5.5 High\n'
                        ));
                    }
                })
            },
            stderr: { on: vi.fn() },
            on: vi.fn((event: string, handler: (code: number) => void) => {
                if (event === 'exit') {
                    setTimeout(() => handler(0), 0);
                }
            }),
            kill: vi.fn()
        }));

        const result = await listCursorModels();

        expect(result.cliModelSkus?.map((row) => row.modelId)).toEqual([
            'gpt-5.5-medium',
            'gpt-5.5-high-fast',
            'gpt-5.5-high'
        ]);
        expect(spawnMock).toHaveBeenCalled();
    });

    test('prefers ACP wire probe over CLI slug probe when cache is empty', async () => {
        acpProbeMock.runCursorAcpModelProbe.mockResolvedValue({
            success: true,
            availableModels: [{ modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }],
            currentModelId: 'composer-2.5[fast=true]'
        });
        spawnMock.mockImplementation(() => ({
            stdout: {
                on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
                    if (event === 'data') {
                        handler(Buffer.from('composer-2.5-fast - Composer 2.5 Fast\n'));
                    }
                })
            },
            stderr: { on: vi.fn() },
            on: vi.fn((event: string, handler: (code: number) => void) => {
                if (event === 'exit') {
                    setTimeout(() => handler(0), 0);
                }
            }),
            kill: vi.fn()
        }));

        const result = await listCursorModels();

        expect(acpProbeMock.runCursorAcpModelProbe).toHaveBeenCalled();
        expect(result.availableModels).toEqual([
            { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
        ]);
        expect(result.cliModelSkus?.some((row) => row.modelId === 'composer-2.5-fast')).toBe(true);
    });

    test('does not cache CLI slug probe when ACP probe returns no wires', async () => {
        acpProbeMock.runCursorAcpModelProbe.mockResolvedValue({
            success: false,
            error: 'no acp'
        });
        spawnMock.mockImplementation(() => ({
            stdout: {
                on: vi.fn((event: string, handler: (chunk: Buffer) => void) => {
                    if (event === 'data') {
                        handler(Buffer.from('composer-2.5 - Composer 2.5 (current)\n'));
                    }
                })
            },
            stderr: { on: vi.fn() },
            on: vi.fn((event: string, handler: (code: number) => void) => {
                if (event === 'exit') {
                    setTimeout(() => handler(0), 0);
                }
            }),
            kill: vi.fn()
        }));

        const result = await listCursorModels();

        expect(result).toEqual({
            success: true,
            availableModels: [],
            currentModelId: null
        });
    });

    test('skips CLI slug probe when ACP lock is active after ACP probe', async () => {
        vi.mocked(isAgentAcpTransportActive)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        acpProbeMock.runCursorAcpModelProbe.mockResolvedValue({
            success: false,
            error: 'no wires'
        });

        const result = await listCursorModels();

        expect(spawnMock).not.toHaveBeenCalled();
        expect(result).toEqual({ success: false, error: 'no wires' });
    });

    test('prefers live ACP snapshot over cache while ACP transport is active', async () => {
        vi.mocked(isAgentAcpTransportActive).mockReturnValue(true)
        seedCursorModelsCache({
            success: true,
            availableModels: [{ modelId: 'stale' }],
            currentModelId: 'stale'
        })
        setCursorAcpModelsSnapshot({
            availableModels: [{ modelId: 'composer-2.5-fast', name: 'Composer 2.5 Fast' }],
            currentModelId: 'composer-2.5-fast'
        })

        const result = await listCursorModels()

        expect(result.currentModelId).toBe('composer-2.5-fast')
    })
})
