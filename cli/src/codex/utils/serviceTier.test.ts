import { describe, expect, it, vi } from 'vitest';
import { isUltrafastAvailable } from './serviceTier';

describe('Ultrafast model/account availability', () => {
    const models = [
        { id: 'gpt-6.2-sol', isDefault: true, serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
        { id: 'gpt-6.2-astra', serviceTiers: [{ id: 'ultrafast' }] },
        { id: 'gpt-6-astra', serviceTiers: [{ id: 'ultrafast' }] },
        { id: 'gpt-6.1-sol', serviceTiers: [{ id: 'priority' }] },
    ];

    it.each(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', undefined])('accepts advertised tier for %s', async model => {
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels: vi.fn().mockResolvedValue({ data: models }) }, model)).resolves.toBe(true);
    });

    it.each(['gpt-6.1-sol', 'unknown'])('rejects unsupported model %s', async model => {
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels: vi.fn().mockResolvedValue({ data: models }) }, model)).resolves.toBe(false);
    });

    it('does not infer account entitlement from a supported model name', async () => {
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels: vi.fn().mockResolvedValue({ data: [
            { id: 'gpt-6.2-sol', serviceTiers: [{ id: 'priority' }] },
        ] }) }, 'gpt-6.2-sol')).resolves.toBe(false);
    });

    it('reads later catalog pages', async () => {
        const listModels = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: models });
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels }, 'gpt-6.2-sol')).resolves.toBe(true);
        expect(listModels).toHaveBeenLastCalledWith({ includeHidden: true, cursor: 'page2' });
    });

    it('resolves the configured launch model before using the catalog default', async () => {
        const readConfig = vi.fn().mockResolvedValue({ config: { model: 'gpt-6.1-sol' } });
        const listModels = vi.fn().mockResolvedValue({ data: models });
        expect(await isUltrafastAvailable({ readConfig, listModels }, undefined, '/project')).toBe(false);
        expect(readConfig).toHaveBeenCalledWith({ cwd: '/project', includeLayers: false });
        readConfig.mockResolvedValueOnce({ config: { model: 'gpt-6-astra' } });
        expect(await isUltrafastAvailable({ readConfig, listModels }, undefined, '/project')).toBe(true);
    });

    it('keeps an explicit launch model ahead of native config', async () => {
        const readConfig = vi.fn().mockResolvedValue({ config: { model: 'gpt-6.1-sol' } });
        const listModels = vi.fn().mockResolvedValue({ data: models });
        expect(await isUltrafastAvailable({ readConfig, listModels }, 'gpt-6.2-sol', '/project')).toBe(true);
        expect(readConfig).not.toHaveBeenCalled();
    });

    it('bounds a stalled catalog without treating timeout as missing entitlement', async () => {
        vi.useFakeTimers();
        try {
            const pending = isUltrafastAvailable({ readConfig: vi.fn(), listModels: vi.fn(() => new Promise(() => {})) }, 'gpt-6.2-sol');
            const rejected = expect(pending).rejects.toThrow('timed out');
            await vi.advanceTimersByTimeAsync(10_001);
            await rejected;
        } finally { vi.useRealTimers(); }
    });
});
