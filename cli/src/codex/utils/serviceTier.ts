import type { CodexAppServerClient } from '../codexAppServerClient';

/** Validate against the same native account/provider that will execute the thread. */
export async function assertUltrafastAvailable(
    client: Pick<CodexAppServerClient, 'listModels'>,
    model: unknown,
): Promise<void> {
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
    const selected = typeof model === 'string' && model.trim()
        ? models.find(entry => entry.id === model || entry.model === model)
        : models.find(entry => entry.isDefault);
    if (!selected?.serviceTiers?.some(tier => tier.id === 'ultrafast')) {
        throw new Error('Ultrafast is not available for this model in the current Codex account. Select Standard or Fast.');
    }
}
