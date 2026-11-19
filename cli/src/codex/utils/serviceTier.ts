import type { CodexAppServerClient } from '../codexAppServerClient';

/** Validate against the same native account/provider that will execute the thread. */
export const ULTRAFAST_FALLBACK_NOTICE = 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.';
export const ULTRAFAST_DISABLED_NOTICE = 'Ultrafast is disabled in the current Codex configuration; changed to Standard.';

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

export async function isUltrafastAvailable(
    client: Pick<CodexAppServerClient, 'listModels' | 'readConfig'> & Partial<Pick<CodexAppServerClient, 'supportsProviderScopedModels'>>,
    model: unknown,
    cwd?: string,
    deadline = Date.now() + 10_000,
    modelProvider?: string,
    catalogProvider?: string,
): Promise<boolean> {
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
    const configured = !explicitModel || !modelProvider
        ? (await bounded(() => client.readConfig({ cwd, includeLayers: false }))).config : undefined;
    const effectiveProvider = modelProvider ?? (typeof configured?.model_provider === 'string' ? configured.model_provider : 'openai');
    if (!scoped && catalogProvider !== effectiveProvider) throw new Error('Cannot verify Ultrafast for a different Codex model provider; settings were not changed');
    const effectiveModel = explicitModel ?? (typeof configured?.model === 'string' && configured.model.trim() ? configured.model : undefined);
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
    const selected = effectiveModel
        ? models.find(entry => entry.id === effectiveModel || entry.model === effectiveModel)
        : models.find(entry => entry.isDefault);
    return Boolean(selected?.serviceTiers?.some(tier => tier.id === 'ultrafast'));
}

/** Explicitly re-resolve inherited intent so a saved native snapshot cannot pin it. */
export async function inheritedResumeTier(client: Pick<CodexAppServerClient, 'readConfig'>, params: Record<string, unknown>, explicit: boolean | undefined, cwd: string, savedTier?: unknown): Promise<Record<string, unknown>> {
    if (params.serviceTier !== undefined) return params;
    if (explicit === true) {
        if (savedTier === 'standard') return { ...params, serviceTier: null };
        if (savedTier === 'fast') return { ...params, serviceTier: 'priority' };
        if (savedTier === 'ultrafast') return { ...params, serviceTier: 'ultrafast' };
    }
    if (explicit !== false) return params;
    const configured = (await client.readConfig({ cwd, includeLayers: false })).config.service_tier;
    return { ...params, serviceTier: typeof configured === 'string' && configured !== 'default' ? configured : null };
}

/** One eligibility resolver for HAPI launches and native gateway lifecycle requests. */
export async function resolveUltrafastLaunch(
    client: Pick<CodexAppServerClient, 'request' | 'listModels' | 'readConfig' | 'retainsResumeModelProvider' | 'supportsProviderScopedModels'>,
    method: string, params: Record<string, unknown>, cwd: string, catalogProvider?: string,
    savedThread?: Record<string, unknown>,
): Promise<{ params: Record<string, unknown>; downgraded: boolean }> {
    if (params.serviceTier !== 'ultrafast') return { params, downgraded: false };
    const deadline = Date.now() + 10_000;
    const response = !savedThread && method !== 'thread/start'
        ? await client.request<{ thread: Record<string, unknown> }>('thread/read', { threadId: params.threadId, includeTurns: false }) : undefined;
    const saved = savedThread ?? response?.thread ?? {};
    const config = params.config && typeof params.config === 'object' ? params.config as Record<string, unknown> : {};
    const provider = params.modelProvider ?? config.model_provider;
    const context = method === 'thread/resume'
        ? resumeTierContext(params, saved, client.retainsResumeModelProvider())
        : { model: params.model ?? config.model, modelProvider: typeof provider === 'string' ? provider : undefined };
    const available = await isUltrafastAvailable(client, context.model, typeof params.cwd === 'string' ? params.cwd : typeof saved.cwd === 'string' ? saved.cwd : cwd, deadline, context.modelProvider, catalogProvider);
    return { params: available ? params : { ...params, serviceTier: null }, downgraded: !available };
}
