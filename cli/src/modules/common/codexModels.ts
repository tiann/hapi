import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { getErrorMessage } from './rpcResponses';

export interface CodexModelSummary {
    id: string;
    displayName: string;
    isDefault: boolean;
    defaultReasoningEffort?: string | null;
    supportedReasoningEfforts?: string[];
}

export interface ListCodexModelsRequest {
    includeHidden?: boolean;
}

export interface ListCodexModelsResponse {
    success: boolean;
    models?: CodexModelSummary[];
    error?: string;
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

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
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

        return models;
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to list Codex models'));
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
