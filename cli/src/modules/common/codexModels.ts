import { homedir } from 'node:os';
import type { CodexModelsResponse, CodexModelSummary } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { getErrorMessage } from './rpcResponses';

export interface ListCodexModelsRequest {
    includeHidden?: boolean;
}

export type ListCodexModelsResponse = CodexModelsResponse;

function asNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSupportedReasoningEfforts(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const efforts = value
        .map((entry) => {
            if (!entry || typeof entry !== 'object') {
                return null;
            }
            const reasoningEffort = asNonEmptyString((entry as { reasoningEffort?: unknown }).reasoningEffort);
            return reasoningEffort;
        })
        .filter((entry): entry is string => entry !== null);

    return efforts.length > 0 ? efforts : undefined;
}

// The Codex model catalog advertises which service tiers are available for a
// model in the *current* account/auth context — e.g. an API-key session or a
// plan without Fast credits simply won't list a Fast tier. We surface the tier
// id AND display name as lowercased search tokens so the web can gate the
// Fast-mode toggle on real availability. The Fast tier's catalog id is
// `'priority'` but its name is `'Fast'`, so capturing the name is what lets a
// `/fast/i` match recognise it. (See OpenAI Codex speed docs: Fast maps to the
// request value `priority`.)
function normalizeServiceTiers(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const tokens = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const record = entry as { id?: unknown; name?: unknown };
        const id = asNonEmptyString(record.id);
        const name = asNonEmptyString(record.name);
        if (id) tokens.add(id.toLowerCase());
        if (name) tokens.add(name.toLowerCase());
    }

    return tokens.size > 0 ? [...tokens] : undefined;
}

function normalizeModel(entry: unknown): CodexModelSummary | null {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const record = entry as Record<string, unknown>;
    const id = asNonEmptyString(record.id) ?? asNonEmptyString(record.model);
    if (!id) {
        return null;
    }

    return {
        id,
        displayName: asNonEmptyString(record.displayName) ?? id,
        isDefault: record.isDefault === true,
        defaultReasoningEffort: asNonEmptyString(record.defaultReasoningEffort),
        defaultServiceTier: asNonEmptyString(record.defaultServiceTier),
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(record.supportedReasoningEfforts),
        serviceTiers: normalizeServiceTiers(record.serviceTiers)
    };
}

interface CacheEntry {
    expiresAt: number;
    models: CodexModelSummary[];
}

// The Codex catalog is account-scoped and changes rarely. Each uncached call
// spawns a fresh `codex app-server` subprocess and validates the ChatGPT
// session, which can take 2-30s when a token refresh or network round trip is
// involved. Cache successful lists for 5 minutes (same shape as the opencode
// model cache) and coalesce concurrent requests into a single spawn.
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<boolean, CacheEntry>();
const inflight = new Map<boolean, Promise<CodexModelSummary[]>>();

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
    const cached = cache.get(includeHidden);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.models;
    }

    const existing = inflight.get(includeHidden);
    if (existing) {
        return existing;
    }

    const promise = fetchCodexModelsFromAppServer(includeHidden)
        .then((models) => {
            if (models.length > 0) {
                cache.set(includeHidden, {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    models
                });
            }
            return models;
        })
        .finally(() => {
            inflight.delete(includeHidden);
        });

    inflight.set(includeHidden, promise);
    return promise;
}

async function fetchCodexModelsFromAppServer(includeHidden: boolean): Promise<CodexModelSummary[]> {
    // Model discovery is account-scoped. Never inherit a session/runner cwd:
    // project config or a deleted worktree must not alter or break the catalog.
    const client = new CodexAppServerClient({ cwd: homedir() });

    try {
        await client.connect();
        await client.initialize({
            clientInfo: {
                name: 'hapi-codex-models',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        const response = await client.listModels({ includeHidden });
        return Array.isArray(response.data)
            ? response.data.map(normalizeModel).filter((model): model is CodexModelSummary => model !== null)
            : [];
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to list Codex models'));
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

/**
 * Clear the in-process cache and any in-flight probe. Exposed for tests.
 */
export function _resetCodexModelsCacheForTests(): void {
    cache.clear();
    inflight.clear();
}
