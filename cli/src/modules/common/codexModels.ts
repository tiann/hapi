import type { CodexModelsResponse, CodexModelSummary } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { getErrorMessage } from './rpcResponses';

export interface ListCodexModelsRequest {
    includeHidden?: boolean;
}

export type ListCodexModelsResponse = CodexModelsResponse;

const CODEX_MODEL_CACHE_TTL_MS = 300_000;

type CodexModelCache = { models: CodexModelSummary[]; expiry: number };

let codexModelCache: CodexModelCache | null = null;
let hiddenCodexModelCache: CodexModelCache | null = null;

export function clearCodexModelCache(): void {
    codexModelCache = null;
    hiddenCodexModelCache = null;
}

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
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(record.supportedReasoningEfforts)
    };
}

function createCodexModelListError(error: unknown): Error {
    const message = getErrorMessage(error, 'Failed to list Codex models');
    return new Error(`Failed to list Codex models: ${message}`, { cause: error });
}

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
    const now = Date.now();
    const cache = includeHidden ? hiddenCodexModelCache : codexModelCache;
    if (cache && cache.expiry > now) {
        return cache.models;
    }

    const client = new CodexAppServerClient();

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
        const models = Array.isArray(response.data)
            ? response.data.map(normalizeModel).filter((model): model is CodexModelSummary => model !== null)
            : [];

        const nextCache = {
            models,
            expiry: Date.now() + CODEX_MODEL_CACHE_TTL_MS
        };
        if (includeHidden) {
            hiddenCodexModelCache = nextCache;
        } else {
            codexModelCache = nextCache;
        }

        return models;
    } catch (error) {
        throw createCodexModelListError(error);
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
