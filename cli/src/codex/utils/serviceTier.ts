import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CodexAppServerClient } from '../codexAppServerClient';

/** Validate against the same native account/provider that will execute the thread. */
export const ULTRAFAST_FALLBACK_NOTICE = 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.';
export const ULTRAFAST_DISABLED_NOTICE = 'Ultrafast is disabled in the current Codex configuration; changed to Standard.';

const providerConfigKeys = new Set([
    'model_providers', 'openai_base_url', 'chatgpt_base_url', 'model_catalog_json',
    'forced_login_method', 'forced_chatgpt_workspace_id', 'profile', 'profiles'
]);
const providerConfigKey = (key: string): boolean => providerConfigKeys.has(key.split('.', 1)[0]);
const providerFields = (value: unknown): Record<string, unknown> => value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => providerConfigKey(key)))
    : {};

export async function catalogConfiguration(response: Awaited<ReturnType<CodexAppServerClient['readConfig']>>): Promise<unknown> {
    if (!Array.isArray(response.layers)) return undefined;
    const configuredPath = response.config.model_catalog_json;
    let staticCatalog: { path: string; hash: string } | undefined;
    if (configuredPath != null) {
        if (typeof configuredPath !== 'string') return undefined;
        try {
            const file = configuredPath.startsWith('file:') ? fileURLToPath(configuredPath) : configuredPath;
            if (!isAbsolute(file)) return undefined;
            const path = await realpath(file);
            staticCatalog = { path, hash: createHash('sha256').update(await readFile(path)).digest('hex') };
        } catch { return undefined; }
    }
    return {
        config: providerFields(response.config),
        ...(staticCatalog ? { staticCatalog } : {}),
        layers: response.layers.flatMap(layer => {
            if (!layer || layer.disabledReason) return [];
            const fields = providerFields(layer.config);
            return Object.keys(fields).length ? [fields] : [];
        })
    };
}

export async function catalogConfigurationMatches(startup: unknown, response: Awaited<ReturnType<CodexAppServerClient['readConfig']>>): Promise<boolean> {
    return startup != null && isDeepStrictEqual(startup, await catalogConfiguration(response));
}

/** Selected tier notifications do not prove the native execution feature is enabled. */
export async function isUltrafastEnabled(client: Pick<CodexAppServerClient, 'request'>, threadId: string, deadline = Date.now() + 10_000): Promise<boolean> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Codex feature discovery timed out; settings were not changed');
        let timer: ReturnType<typeof setTimeout> | undefined;
        let page: { data: Array<{ name: string; enabled: boolean }>; nextCursor?: string | null };
        try {
            page = await Promise.race([client.request<typeof page>(
                'experimentalFeature/list', { threadId, limit: 100, ...(cursor ? { cursor } : {}) }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Codex feature discovery timed out; settings were not changed')), remaining); })]);
        } finally { clearTimeout(timer); }
        const feature = page.data.find(entry => entry.name === 'ultrafast_mode');
        if (feature) return feature.enabled === true;
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Codex feature pagination did not advance; settings were not changed');
        if (cursor) seen.add(cursor);
    } while (cursor);
    throw new Error('Codex did not report effective Ultrafast enablement; settings were not changed');
}

/** Match native has_model_resume_override before choosing a catalog context. */
export function resumeTierContext(params: Record<string, unknown>, saved: Record<string, unknown>, providerRetained = false): { model: unknown; modelProvider?: string } {
    const config = params.config && typeof params.config === 'object' ? params.config as Record<string, unknown> : {};
    const overridden = params.model != null || params.modelProvider != null
        || config.model !== undefined || (providerRetained && config.model_provider !== undefined) || config.model_reasoning_effort !== undefined;
    const provider = providerRetained
        ? params.modelProvider ?? config.model_provider ?? saved.modelProvider
        : overridden ? params.modelProvider ?? config.model_provider : saved.modelProvider;
    return { model: overridden ? params.model ?? config.model : saved.model,
        modelProvider: typeof provider === 'string' ? provider : undefined };
}

export async function discoverUltrafastTarget(
    client: Pick<CodexAppServerClient, 'listModels' | 'readConfig'> & Partial<Pick<CodexAppServerClient, 'supportsProviderScopedModels' | 'supportsEffectiveUltrafastLaunch'>>,
    model: unknown,
    cwd?: string,
    deadline = Date.now() + 10_000,
    modelProvider?: string,
    catalogProvider?: string,
    startupCatalogConfig?: unknown,
): Promise<{ available: boolean; model: string | undefined; provider: string }> {
    if (client.supportsEffectiveUltrafastLaunch?.() === false) {
        throw new Error('Ultrafast requires Codex 0.170 or newer to verify execution; settings were not changed');
    }
    const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Codex tier discovery timed out; settings were not changed');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([operation(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Codex tier discovery timed out; settings were not changed')), remaining);
            })]);
        } finally { clearTimeout(timer); }
    };
    const scoped = client.supportsProviderScopedModels?.() === true;
    if (!scoped && !catalogProvider) throw new Error('Cannot verify the Codex catalog provider; settings were not changed');
    const explicitModel = typeof model === 'string' && model.trim() ? model : undefined;
    const verifyConfig = scoped && startupCatalogConfig !== undefined;
    const startup = verifyConfig ? await bounded(() => Promise.resolve(startupCatalogConfig)) : undefined;
    const current = verifyConfig || !explicitModel || !modelProvider
        ? await bounded(() => client.readConfig({ cwd, includeLayers: verifyConfig })) : undefined;
    const assertCatalogConfiguration = async (response: typeof current) => {
        if (!response || !await bounded(() => catalogConfigurationMatches(startup, response))) {
            throw new Error('Cannot verify the Codex catalog against the launch provider configuration; settings were not changed. Restart the Codex runtime and retry.');
        }
    };
    if (verifyConfig) await assertCatalogConfiguration(current);
    const target = (configured: typeof current) => ({
        effectiveProvider: modelProvider ?? (typeof configured?.config.model_provider === 'string' ? configured.config.model_provider : 'openai'),
        effectiveModel: explicitModel ?? (typeof configured?.config.model === 'string' && configured.config.model.trim() ? configured.config.model : undefined)
    });
    const { effectiveModel, effectiveProvider } = target(current);
    if (!scoped && catalogProvider !== effectiveProvider) throw new Error('Cannot verify Ultrafast for a different Codex model provider; settings were not changed');
    const models = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await bounded(() => client.listModels({ includeHidden: true, ...(scoped ? { modelProvider: effectiveProvider } : {}), ...(cursor ? { cursor } : {}) }));
        models.push(...page.data ?? []);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Codex model catalog pagination did not advance');
        if (cursor) seen.add(cursor);
    } while (cursor);
    if (verifyConfig) {
        const finalConfig = await bounded(() => client.readConfig({ cwd, includeLayers: true }));
        await assertCatalogConfiguration(finalConfig);
        const finalTarget = target(finalConfig);
        if (finalTarget.effectiveModel !== effectiveModel || finalTarget.effectiveProvider !== effectiveProvider) {
            throw new Error('The effective Codex model or provider changed during tier discovery; settings were not changed. Retry with the current configuration.');
        }
    }
    const selected = effectiveModel
        ? models.find(entry => entry.id === effectiveModel || entry.model === effectiveModel)
        : models.find(entry => entry.isDefault);
    return {
        available: Boolean(selected?.serviceTiers?.some(tier => tier.id === 'ultrafast')),
        model: effectiveModel ?? selected?.model ?? selected?.id,
        provider: effectiveProvider
    };
}

export async function isUltrafastAvailable(...parameters: Parameters<typeof discoverUltrafastTarget>): Promise<boolean> {
    return (await discoverUltrafastTarget(...parameters)).available;
}

/** Native top-level tier overrides request config, which overrides inheritance. */
export function nativeTierParams(params: Record<string, unknown>): Record<string, unknown> {
    const config = params.config && typeof params.config === 'object' ? params.config as Record<string, unknown> : {};
    return params.serviceTier === undefined && config.service_tier !== undefined
        ? { ...params, serviceTier: config.service_tier === 'default' ? null : config.service_tier } : params;
}

/** Explicitly re-resolve inherited intent so a saved native snapshot cannot pin it. */
export async function inheritedResumeTier(client: Pick<CodexAppServerClient, 'readConfig'> & Partial<Pick<CodexAppServerClient, 'supportsEffectiveUltrafastLaunch'>>, params: Record<string, unknown>, explicit: boolean | undefined, cwd: string, savedTier?: unknown, pendingTier?: 'standard' | 'fast' | 'ultrafast' | 'flex', confirmationPending = false): Promise<Record<string, unknown>> {
    params = nativeTierParams(params);
    if (params.serviceTier !== undefined) return params;
    if (confirmationPending && pendingTier === undefined) return params;
    if (pendingTier !== undefined || explicit === true) {
        const tier = pendingTier ?? savedTier;
        if (tier === 'standard') return { ...params, serviceTier: null };
        if (tier === 'fast') return { ...params, serviceTier: 'priority' };
        if (tier === 'ultrafast') return { ...params, serviceTier: 'ultrafast' };
        if (tier === 'flex') return { ...params, serviceTier: 'flex' };
    }
    if (explicit !== false) return params;
    const configured = (await client.readConfig({ cwd, includeLayers: false })).config.service_tier;
    // Omission is different from native's explicit Standard sentinel. When no
    // account override exists, retain native snapshot/default behavior.
    if (configured == null || configured === 'ultrafast' && client.supportsEffectiveUltrafastLaunch?.() === false) return params;
    return { ...params, serviceTier: typeof configured === 'string' && configured !== 'default' ? configured : null };
}

/** One eligibility resolver for HAPI launches and native gateway lifecycle requests. */
export async function resolveUltrafastLaunch(
    client: Pick<CodexAppServerClient, 'request' | 'listModels' | 'readConfig' | 'retainsResumeModelProvider' | 'supportsProviderScopedModels'>,
    method: string, params: Record<string, unknown>, cwd: string, catalogProvider?: string,
    savedThread?: Record<string, unknown>,
    startupCatalogConfig?: unknown,
): Promise<{ params: Record<string, unknown>; downgraded: boolean }> {
    params = nativeTierParams(params);
    if (params.serviceTier !== 'ultrafast') return { params, downgraded: false };
    const deadline = Date.now() + 10_000;
    const response = !savedThread && method !== 'thread/start'
        ? await client.request<{ thread: Record<string, unknown> }>('thread/read', { threadId: params.threadId, includeTurns: false }) : undefined;
    const saved = savedThread ?? response?.thread ?? {};
    const config = params.config && typeof params.config === 'object' ? params.config as Record<string, unknown> : {};
    if (Object.keys(config).some(providerConfigKey)) {
        throw new Error('Cannot verify the Codex catalog for request-level provider configuration overrides; settings were not changed');
    }
    const provider = params.modelProvider ?? config.model_provider;
    const context = method === 'thread/resume'
        ? resumeTierContext(params, saved, client.retainsResumeModelProvider())
        : { model: params.model ?? config.model, modelProvider: typeof provider === 'string' ? provider : undefined };
    const { available, model, provider: effectiveProvider } = await discoverUltrafastTarget(client, context.model, typeof params.cwd === 'string' ? params.cwd : typeof saved.cwd === 'string' ? saved.cwd : cwd, deadline, context.modelProvider, catalogProvider, startupCatalogConfig);
    if (method === 'thread/start') {
        // A fresh thread accepts explicit model/provider overrides. Fix the
        // validated target before dispatch, including a Standard fallback.
        params = {
            ...params,
            ...(context.model == null && model ? { model } : {}),
            ...(context.modelProvider === undefined ? { modelProvider: effectiveProvider } : {})
        };
    }
    return { params: available ? params : { ...params, serviceTier: null }, downgraded: !available };
}
