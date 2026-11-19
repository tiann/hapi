import type { CodexAppServerClient } from '../codexAppServerClient';

/** Validate against the same native account/provider that will execute the thread. */
export const ULTRAFAST_FALLBACK_NOTICE = 'Ultrafast is not supported by this model or subscription; changed to Standard.';

export async function isUltrafastAvailable(
    client: Pick<CodexAppServerClient, 'listModels' | 'readConfig'>,
    model: unknown,
    cwd?: string,
): Promise<boolean> {
    const explicitModel = typeof model === 'string' && model.trim() ? model : undefined;
    const configured = explicitModel ? undefined : (await client.readConfig({ cwd, includeLayers: false })).config.model;
    const effectiveModel = explicitModel ?? (typeof configured === 'string' && configured.trim() ? configured : undefined);
    const models = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
        const page = await client.listModels({ includeHidden: true, ...(cursor ? { cursor } : {}) });
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
