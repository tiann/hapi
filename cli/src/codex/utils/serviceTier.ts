import type { CodexAppServerClient } from '../codexAppServerClient';

/** Validate against the same native account/provider that will execute the thread. */
export const ULTRAFAST_FALLBACK_NOTICE = 'Ultrafast was not advertised by the current Codex model catalog; changed to Standard.';

export async function isUltrafastAvailable(
    client: Pick<CodexAppServerClient, 'listModels' | 'readConfig'>,
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
    if (!catalogProvider) throw new Error('Cannot verify the Codex catalog provider; settings were not changed');
    const explicitModel = typeof model === 'string' && model.trim() ? model : undefined;
    const configured = !explicitModel || !modelProvider
        ? (await bounded(() => client.readConfig({ cwd, includeLayers: false }))).config : undefined;
    const effectiveProvider = modelProvider ?? (typeof configured?.model_provider === 'string' ? configured.model_provider : 'openai');
    if (catalogProvider !== effectiveProvider) throw new Error('Cannot verify Ultrafast for a different Codex model provider; settings were not changed');
    const effectiveModel = explicitModel ?? (typeof configured?.model === 'string' && configured.model.trim() ? configured.model : undefined);
    const models = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await bounded(() => client.listModels({ includeHidden: true, ...(cursor ? { cursor } : {}) }));
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
