import { describe, expect, it, vi } from 'vitest';
import { assertUltrafastAvailable } from './serviceTier';

describe('Ultrafast model/account availability', () => {
    const models = [
        { id: 'gpt-6.2-sol', isDefault: true, serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
        { id: 'gpt-6.2-astra', serviceTiers: [{ id: 'ultrafast' }] },
        { id: 'gpt-6-astra', serviceTiers: [{ id: 'ultrafast' }] },
        { id: 'gpt-6.1-sol', serviceTiers: [{ id: 'priority' }] },
    ];

    it.each(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', undefined])('accepts advertised tier for %s', async model => {
        await expect(assertUltrafastAvailable({ listModels: vi.fn().mockResolvedValue({ data: models }) }, model)).resolves.toBeUndefined();
    });

    it.each(['gpt-6.1-sol', 'unknown'])('rejects unsupported model %s', async model => {
        await expect(assertUltrafastAvailable({ listModels: vi.fn().mockResolvedValue({ data: models }) }, model)).rejects.toThrow('not available');
    });

    it('does not infer account entitlement from a supported model name', async () => {
        await expect(assertUltrafastAvailable({ listModels: vi.fn().mockResolvedValue({ data: [
            { id: 'gpt-6.2-sol', serviceTiers: [{ id: 'priority' }] },
        ] }) }, 'gpt-6.2-sol')).rejects.toThrow('not available');
    });

    it('reads later catalog pages', async () => {
        const listModels = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: models });
        await expect(assertUltrafastAvailable({ listModels }, 'gpt-6.2-sol')).resolves.toBeUndefined();
        expect(listModels).toHaveBeenLastCalledWith({ includeHidden: true, cursor: 'page2' });
    });
});
