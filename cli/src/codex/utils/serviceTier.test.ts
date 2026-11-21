import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { catalogConfiguration, isUltrafastAvailable, isUltrafastEnabled, inheritedResumeTier, resumeTierContext, resolveUltrafastLaunch } from './serviceTier';

it('preserves the native tier while lost-write confirmation is pending', async () => {
    const readConfig = vi.fn();
    expect(await inheritedResumeTier({ readConfig }, {}, false, '/project', 'standard', undefined, true)).toEqual({});
    expect(await inheritedResumeTier({ readConfig }, {}, false, '/project', 'fast', 'standard', true)).toEqual({ serviceTier: null });
    expect(readConfig).not.toHaveBeenCalled();
});

it('leaves the requested tier untouched when the same provider changes catalog endpoint', async () => {
    const configuration = (baseUrl: string) => ({
        config: { model_provider: 'custom' },
        layers: [{ config: { model_providers: { custom: { base_url: baseUrl } } } }]
    });
    const listModels = vi.fn();
    const client = {
        readConfig: vi.fn().mockResolvedValue(configuration('https://new.example.test')),
        listModels,
        request: vi.fn(), retainsResumeModelProvider: () => true, supportsProviderScopedModels: () => true,
    };
    const requested = { model: 'eligible', modelProvider: 'custom', serviceTier: 'ultrafast' };
    await expect(resolveUltrafastLaunch(client, 'thread/start', requested, '/project', undefined, undefined,
        await catalogConfiguration(configuration('https://old.example.test')))).rejects.toThrow('launch provider configuration');
    expect(listModels).not.toHaveBeenCalled();
    expect(requested.serviceTier).toBe('ultrafast');
});

it.each([
    { params: {}, next: { model: 'other', model_provider: 'original-provider' }, changed: true },
    { params: { model: 'eligible' }, next: { model: 'eligible', model_provider: 'other-provider' }, changed: true },
    { params: { model: 'eligible', modelProvider: 'original-provider' }, next: { model: 'other', model_provider: 'other-provider' }, changed: false },
])('rechecks the effective launch target after reading the catalog ($params)', async ({ params, next, changed }) => {
    const original = { config: { model: 'eligible', model_provider: 'original-provider' }, layers: [] };
    const client = {
        readConfig: vi.fn().mockResolvedValueOnce(original).mockResolvedValueOnce({ config: next, layers: [] }),
        listModels: vi.fn().mockResolvedValue({ data: [{ id: 'eligible', serviceTiers: [{ id: 'ultrafast' }] }] }),
        request: vi.fn(), retainsResumeModelProvider: () => true, supportsProviderScopedModels: () => true,
    };
    const requested = { ...params, serviceTier: 'ultrafast' };
    const launch = resolveUltrafastLaunch(client, 'thread/start', requested, '/project', undefined, undefined, await catalogConfiguration(original));
    if (changed) await expect(launch).rejects.toThrow('effective Codex model or provider changed');
    else await expect(launch).resolves.toEqual({
        params: requested, downgraded: false, ultrafastTarget: { model: 'eligible', provider: 'original-provider' }
    });
    expect(client.listModels).toHaveBeenCalledExactlyOnceWith({ includeHidden: true, modelProvider: 'original-provider' });
    expect(client.readConfig).toHaveBeenCalledTimes(2);
});

it('stops tier discovery when a static catalog changes in place during lookup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-static-catalog-'));
    try {
        const file = join(dir, 'models.json');
        await writeFile(file, '{"models":[]}');
        const config = { config: { model: 'eligible', model_provider: 'openai', model_catalog_json: pathToFileURL(file).href }, layers: [] };
        const startup = await catalogConfiguration(config);
        const listModels = vi.fn(async () => {
            await writeFile(file, '{"models":[{"id":"eligible"}]}');
            return { data: [] };
        });
        await expect(isUltrafastAvailable({
            supportsProviderScopedModels: () => true, listModels, readConfig: vi.fn().mockResolvedValue(config)
        }, 'eligible', dir, Date.now() + 10_000, 'openai', undefined, startup))
            .rejects.toThrow('Restart the Codex runtime');
        expect(listModels).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['thread/start', 'thread/fork', 'thread/resume'])('applies the same catalog fallback before native %s', async method => {
    const client = {
        request: vi.fn().mockResolvedValue({ thread: { model: 'unsupported', modelProvider: 'saved-provider' } }),
        readConfig: vi.fn().mockResolvedValue({ config: { model_provider: 'configured-provider' } }),
        listModels: vi.fn().mockResolvedValue({ data: [{ id: 'unsupported', serviceTiers: [{ id: 'priority' }] }] }),
        supportsProviderScopedModels: () => true, retainsResumeModelProvider: () => true,
    };
    const original = { threadId: 'source', model: 'unsupported', serviceTier: 'ultrafast' };
    expect(await resolveUltrafastLaunch(client, method, original, '/project')).toEqual({
        params: { ...original, ...(method === 'thread/start' ? { modelProvider: 'configured-provider' } : {}), serviceTier: null },
        downgraded: true,
        ultrafastTarget: { model: 'unsupported', provider: method === 'thread/resume' ? 'saved-provider' : 'configured-provider' }
    });
    expect(original.serviceTier).toBe('ultrafast');
    expect(client.listModels).toHaveBeenCalledWith({ includeHidden: true, modelProvider: method === 'thread/resume' ? 'saved-provider' : 'configured-provider' });
});
it('does not run lifecycle discovery for Standard or an omitted override', async () => {
    const client = { request: vi.fn(), readConfig: vi.fn(), listModels: vi.fn(), supportsProviderScopedModels: () => true, retainsResumeModelProvider: () => true };
    for (const params of [{ serviceTier: null }, {}]) expect(await resolveUltrafastLaunch(client, 'thread/start', params, '/project')).toEqual({ params, downgraded: false });
    expect(client.listModels).not.toHaveBeenCalled(); expect(client.request).not.toHaveBeenCalled();
});
it.each(['thread/start', 'thread/fork', 'thread/resume'])('honors explicit native config model/provider overrides on %s', async method => {
    const client = {
        request: vi.fn().mockResolvedValue({ thread: { model: 'eligible', modelProvider: 'saved-provider' } }),
        readConfig: vi.fn(), listModels: vi.fn().mockResolvedValue({ data: [{ id: 'unsupported', serviceTiers: [] }] }),
        supportsProviderScopedModels: () => true, retainsResumeModelProvider: () => true,
    };
    const params = { threadId: 'source', serviceTier: 'ultrafast', config: { model: 'unsupported', model_provider: 'override-provider' } };
    expect((await resolveUltrafastLaunch(client, method, params, '/project')).downgraded).toBe(true);
    expect(client.listModels).toHaveBeenCalledWith({ includeHidden: true, modelProvider: 'override-provider' });
    expect(client.readConfig).not.toHaveBeenCalled();
});

it('reads effective thread feature state across native pagination', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [{ name: 'fast_mode', enabled: true }], nextCursor: 'next' })
        .mockResolvedValueOnce({ data: [{ name: 'ultrafast_mode', enabled: false }] });
    expect(await isUltrafastEnabled({ request }, 'native-thread')).toBe(false);
    expect(request).toHaveBeenLastCalledWith('experimentalFeature/list', { threadId: 'native-thread', limit: 100, cursor: 'next' });
});
it('does not infer feature enablement when native feature discovery is unavailable', async () => {
    await expect(isUltrafastEnabled({ request: vi.fn().mockResolvedValue({ data: [] }) }, 'thread')).rejects.toThrow('did not report');
});

describe('Ultrafast model/account availability', () => {
    const models = [
        { id: 'gpt-6.2-sol', isDefault: true, serviceTiers: [{ id: 'priority' }, { id: 'ultrafast' }] },
        { id: 'gpt-6.2-astra', serviceTiers: [{ id: 'ultrafast' }] },
        { id: 'gpt-6-astra', serviceTiers: [{ id: 'ultrafast' }] },
        { id: 'gpt-6.1-sol', serviceTiers: [{ id: 'priority' }] },
    ];

    it.each(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-astra', undefined])('accepts advertised tier for %s', async model => {
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels: vi.fn().mockResolvedValue({ data: models }) }, model, undefined, undefined, 'openai', 'openai')).resolves.toBe(true);
    });

    it.each(['gpt-6.1-sol', 'unknown'])('rejects unsupported model %s', async model => {
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels: vi.fn().mockResolvedValue({ data: models }) }, model, undefined, undefined, 'openai', 'openai')).resolves.toBe(false);
    });

    it('does not infer account entitlement from a supported model name', async () => {
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels: vi.fn().mockResolvedValue({ data: [
            { id: 'gpt-6.2-sol', serviceTiers: [{ id: 'priority' }] },
        ] }) }, 'gpt-6.2-sol', undefined, undefined, 'openai', 'openai')).resolves.toBe(false);
    });

    it('reads later catalog pages', async () => {
        const listModels = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: 'page2' })
            .mockResolvedValueOnce({ data: models });
        await expect(isUltrafastAvailable({ readConfig: vi.fn().mockResolvedValue({ config: {} }), listModels }, 'gpt-6.2-sol', undefined, undefined, 'openai', 'openai')).resolves.toBe(true);
        expect(listModels).toHaveBeenLastCalledWith({ includeHidden: true, cursor: 'page2' });
    });

    it('resolves the configured launch model before using the catalog default', async () => {
        const readConfig = vi.fn().mockResolvedValue({ config: { model: 'gpt-6.1-sol' } });
        const listModels = vi.fn().mockResolvedValue({ data: models });
        expect(await isUltrafastAvailable({ readConfig, listModels }, undefined, '/project', undefined, 'openai', 'openai')).toBe(false);
        expect(readConfig).toHaveBeenCalledWith({ cwd: '/project', includeLayers: false });
        readConfig.mockResolvedValueOnce({ config: { model: 'gpt-6-astra' } });
        expect(await isUltrafastAvailable({ readConfig, listModels }, undefined, '/project', undefined, 'openai', 'openai')).toBe(true);
    });

    it('keeps an explicit launch model ahead of native config', async () => {
        const readConfig = vi.fn().mockResolvedValue({ config: { model: 'gpt-6.1-sol' } });
        const listModels = vi.fn().mockResolvedValue({ data: models });
        expect(await isUltrafastAvailable({ readConfig, listModels }, 'gpt-6.2-sol', '/project', undefined, 'openai', 'openai')).toBe(true);
        expect(readConfig).not.toHaveBeenCalled();
    });

    it('bounds a stalled catalog without treating timeout as missing entitlement', async () => {
        vi.useFakeTimers();
        try {
            const pending = isUltrafastAvailable({ readConfig: vi.fn(), listModels: vi.fn(() => new Promise<never>(() => {})) }, 'gpt-6.2-sol', undefined, undefined, 'openai', 'openai');
            const rejected = expect(pending).rejects.toThrow('timed out');
            await vi.advanceTimersByTimeAsync(10_001);
            await rejected;
        } finally { vi.useRealTimers(); }
    });

    it('does not start an unobserved request after its discovery budget expires', async () => {
        const readConfig = vi.fn();
        const listModels = vi.fn();
        await expect(isUltrafastAvailable({ readConfig, listModels }, 'gpt-6.2-sol', '/project', Date.now() - 1, 'openai', 'openai')).rejects.toThrow('timed out');
        expect(readConfig).not.toHaveBeenCalled();
        expect(listModels).not.toHaveBeenCalled();
    });
});

it('does not use one provider catalog to authorize another provider with the same model ID', async () => {
    const listModels = vi.fn().mockResolvedValue({ data: [{ id: 'shared-model', serviceTiers: [{ id: 'ultrafast' }] }] });
    const readConfig = vi.fn().mockResolvedValue({ config: { model_provider: 'startup-provider' } });
    await expect(isUltrafastAvailable({ readConfig, listModels }, 'shared-model', '/project', Date.now() + 10_000, 'thread-provider', 'startup-provider')).rejects.toThrow('different Codex model provider');
    expect(listModels).not.toHaveBeenCalled();
    await expect(isUltrafastAvailable({ readConfig, listModels }, 'shared-model', '/project', Date.now() + 10_000, 'startup-provider', 'startup-provider')).resolves.toBe(true);
});

it('rejects a config provider edited after catalog startup', async () => {
    const listModels = vi.fn().mockResolvedValue({ data: [{ id: 'same-id', serviceTiers: [{ id: 'ultrafast' }] }] });
    const readConfig = vi.fn().mockResolvedValue({ config: { model_provider: 'new-provider' } });
    await expect(isUltrafastAvailable({ readConfig, listModels }, 'same-id', '/project', Date.now() + 10_000, undefined, 'startup-provider')).rejects.toThrow('different Codex model provider');
    expect(listModels).not.toHaveBeenCalled();
});
it('preserves settings when the catalog provider was not captured', async () => {
    await expect(isUltrafastAvailable({ readConfig: vi.fn(), listModels: vi.fn() }, 'same-id')).rejects.toThrow('catalog provider');
});

it.each([
    [{}, { model: 'saved', modelProvider: 'custom' }],
    [{ model: 'selected' }, { model: 'selected', modelProvider: undefined }],
    [{ modelProvider: 'openai' }, { model: undefined, modelProvider: 'openai' }],
    [{ config: { model_reasoning_effort: 'high' } }, { model: undefined, modelProvider: undefined }],
    [{ config: { model: 'configured', model_provider: 'openai' } }, { model: 'configured', modelProvider: 'openai' }],
    [{ config: { model_reasoning_effort: undefined } }, { model: 'saved', modelProvider: 'custom' }],
])('resolves native resume model/provider precedence for %j', (params, expected) => {
    expect(resumeTierContext(params, { model: 'saved', modelProvider: 'custom' })).toEqual(expected);
});

it.each([{ model: 'selected' }, { config: { model_reasoning_effort: 'high' } }])('retains the saved provider on native 0.170 resume with %j', params => {
    expect(resumeTierContext(params, { model: 'saved', modelProvider: 'provider-a' }, true).modelProvider).toBe('provider-a');
});
it('scopes each native 0.170 catalog page to the retained provider after account transitions', async () => {
    const listModels = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: 'next' }).mockResolvedValueOnce({ data: [{ id: 'same-model', serviceTiers: [{ id: 'ultrafast' }] }] });
    const readConfig = vi.fn();
    expect(await isUltrafastAvailable({ listModels, readConfig, supportsProviderScopedModels: () => true }, 'same-model', '/project', Date.now() + 10_000, 'provider-a', 'old-startup-provider')).toBe(true);
    expect(listModels).toHaveBeenNthCalledWith(1, { includeHidden: true, modelProvider: 'provider-a' });
    expect(listModels).toHaveBeenNthCalledWith(2, { includeHidden: true, modelProvider: 'provider-a', cursor: 'next' });
    expect(readConfig).not.toHaveBeenCalled();
});
it.each([['priority', 'priority'], ['ultrafast', 'ultrafast'], ['default', null], [null, undefined], [undefined, undefined]] as const)('resolves the current inherited default %s without inventing Standard', async (configured, native) => {
    const readConfig = vi.fn().mockResolvedValue({ config: { service_tier: configured } });
    expect(await inheritedResumeTier({ readConfig }, { model: 'saved' }, false, '/project')).toEqual({ model: 'saved', ...(native === undefined ? {} : { serviceTier: native }) });
    expect(readConfig).toHaveBeenCalledWith({ cwd: '/project', includeLayers: false });
});
it('does not replace explicit or legacy native tier intent', async () => {
    const readConfig = vi.fn();
    expect(await inheritedResumeTier({ readConfig }, { serviceTier: 'ultrafast' }, true, '/project')).toEqual({ serviceTier: 'ultrafast' });
    expect(await inheritedResumeTier({ readConfig }, {}, undefined, '/project')).toEqual({});
    expect(readConfig).not.toHaveBeenCalled();
});
it.each([['standard', null], ['fast', 'priority'], ['ultrafast', 'ultrafast'], ['flex', 'flex']] as const)('restores an explicit saved %s tier before native resume', async (saved, native) => {
    const readConfig = vi.fn();
    expect(await inheritedResumeTier({ readConfig }, {}, true, '/project', saved)).toEqual({ serviceTier: native });
    expect(await inheritedResumeTier({ readConfig }, { serviceTier: null }, true, '/project', saved)).toEqual({ serviceTier: null });
    expect(readConfig).not.toHaveBeenCalled();
});

it('checks a native fork against destination config rather than the parent model/provider', async () => {
    const client = {
        request: vi.fn().mockResolvedValue({ thread: { model: 'parent-only', modelProvider: 'parent-provider', cwd: '/parent-project' } }),
        readConfig: vi.fn().mockResolvedValue({ config: { model: 'destination', model_provider: 'destination-provider' } }),
        listModels: vi.fn().mockResolvedValue({ data: [{ id: 'destination', serviceTiers: [{ id: 'ultrafast' }] }] }),
        supportsProviderScopedModels: () => true, retainsResumeModelProvider: () => true,
    };
    expect((await resolveUltrafastLaunch(client, 'thread/fork', { threadId: 'parent', serviceTier: 'ultrafast' }, '/runtime-project')).downgraded).toBe(false);
    expect(client.readConfig).toHaveBeenCalledWith({ cwd: '/parent-project', includeLayers: false });
    expect(client.listModels).toHaveBeenCalledWith({ includeHidden: true, modelProvider: 'destination-provider' });
});

it('preserves config tier precedence before inherited resume discovery', async () => {
    const readConfig = vi.fn();
    expect((await inheritedResumeTier({ readConfig }, { config: { service_tier: 'priority' } }, false, '/project')).serviceTier).toBe('priority');
    expect((await inheritedResumeTier({ readConfig }, { serviceTier: null, config: { service_tier: 'priority' } }, false, '/project')).serviceTier).toBeNull();
    expect(readConfig).not.toHaveBeenCalled();
});
it('validates Ultrafast supplied through native lifecycle config', async () => {
    const client = { request: vi.fn(), readConfig: vi.fn().mockResolvedValue({ config: { model: 'standard-only', model_provider: 'openai' } }), listModels: vi.fn().mockResolvedValue({ data: [{ id: 'standard-only' }] }), supportsProviderScopedModels: () => true, retainsResumeModelProvider: () => true };
    const result = await resolveUltrafastLaunch(client, 'thread/start', { config: { service_tier: 'ultrafast' } }, '/project');
    expect(result.downgraded).toBe(true); expect(result.params.serviceTier).toBeNull();
    expect(result.params.config).toEqual({ service_tier: 'ultrafast' });
});
it('uses the explicit execution cwd instead of a saved resume directory for discovery', async () => {
    const client = {
        request: vi.fn(),
        readConfig: vi.fn().mockResolvedValue({ config: { model: 'eligible', model_provider: 'requested-provider' } }),
        listModels: vi.fn().mockResolvedValue({ data: [{ id: 'eligible', serviceTiers: [{ id: 'ultrafast' }] }] }),
        supportsProviderScopedModels: () => true, retainsResumeModelProvider: () => true,
    };
    const result = await resolveUltrafastLaunch(client, 'thread/resume', { cwd: '/requested', serviceTier: 'ultrafast' }, '/runtime', undefined, { cwd: '/saved' });
    expect(result.downgraded).toBe(false);
    expect(result.params.cwd).toBe('/requested');
    expect(client.readConfig).toHaveBeenCalledWith({ cwd: '/requested', includeLayers: false });
});

it.each(['thread/start', 'thread/fork', 'thread/resume'])('rejects unverifiable legacy Ultrafast before native %s', async method => {
    const client = { retainsResumeModelProvider: () => false, supportsEffectiveUltrafastLaunch: () => false, supportsProviderScopedModels: () => false,
        readConfig: vi.fn().mockResolvedValue({ config: { model: 'eligible', model_provider: 'openai', service_tier: 'ultrafast' } }),
        request: vi.fn().mockResolvedValue({ thread: { model: 'eligible', modelProvider: 'openai' } }),
        listModels: vi.fn().mockResolvedValue({ data: [{ id: 'eligible', serviceTiers: [{ id: 'ultrafast' }] }] }) };
    await expect(resolveUltrafastLaunch(client, method, { model: 'eligible', serviceTier: 'ultrafast' }, '/project', 'openai')).rejects.toThrow('Codex 0.170');
    expect(client.listModels).not.toHaveBeenCalled();
});

it('keeps unverifiable inherited native Ultrafast omitted on a legacy engine', async () => {
    const client = { readConfig: vi.fn().mockResolvedValue({ config: { service_tier: 'ultrafast' } }), supportsEffectiveUltrafastLaunch: () => false };
    expect(await inheritedResumeTier(client, {}, false, '/project')).toEqual({});
    expect(await inheritedResumeTier(client, { serviceTier: 'ultrafast' }, false, '/project')).toEqual({ serviceTier: 'ultrafast' });
});
