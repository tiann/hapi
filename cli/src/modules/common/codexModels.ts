import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { logger } from '@/ui/logger';
import { getErrorMessage } from './rpcResponses';

// ---------------------------------------------------------------------------
// Public types (baseline — kept as-is for handler compatibility)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Provider config — reads ~/.codex/config.toml to discover custom providers
// ---------------------------------------------------------------------------

type CodexProviderConfig = {
    defaultModel: string | null;
    modelProvider: string | null;
    providerBaseUrl: string | null;
};

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseQuotedValue(content: string, key: string): string | null {
    const match = content.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, 'm'));
    return match?.[1] ?? null;
}

async function loadCodexProviderConfig(): Promise<CodexProviderConfig> {
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const configPath = join(codexHome, 'config.toml');

    let content = '';
    try {
        content = await readFile(configPath, 'utf8');
    } catch {
        return {
            defaultModel: null,
            modelProvider: null,
            providerBaseUrl: null
        };
    }

    const defaultModel = parseQuotedValue(content, 'model');
    const modelProvider = parseQuotedValue(content, 'model_provider');
    if (!modelProvider) {
        return {
            defaultModel,
            modelProvider: null,
            providerBaseUrl: null
        };
    }

    const providerSectionMatch = content.match(
        new RegExp(`\\[model_providers\\.${escapeRegExp(modelProvider)}\\]([\\s\\S]*?)(?=\\n\\[|$)`)
    );
    const providerSection = providerSectionMatch?.[1] ?? '';
    const providerBaseUrl = parseQuotedValue(providerSection, 'base_url');

    return {
        defaultModel,
        modelProvider,
        providerBaseUrl
    };
}

// ---------------------------------------------------------------------------
// Provider model listing — calls /models on the configured provider base_url
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_EFFORTS: string[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function normalizeProviderBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

function parseProviderModel(
    value: unknown,
    options: { defaultModel: string | null }
): CodexModelSummary | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const record = value as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
    if (!id || !id.includes('/')) {
        return null;
    }

    return {
        id,
        displayName: id,
        isDefault: id === options.defaultModel,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: DEFAULT_REASONING_EFFORTS
    };
}

function filterPreferredProviderNamespace(
    models: CodexModelSummary[],
    defaultModel: string | null
): CodexModelSummary[] {
    if (!defaultModel || !defaultModel.includes('/')) {
        return models;
    }

    const namespace = `${defaultModel.split('/')[0]}/`;
    const scopedModels = models.filter((model) => model.id.startsWith(namespace));
    return scopedModels.length > 0 ? scopedModels : models;
}

async function listModelsFromProvider(): Promise<CodexModelSummary[] | null> {
    const config = await loadCodexProviderConfig();
    if (!config.providerBaseUrl) {
        return null;
    }

    logger.debug(`[codexModels] Fetching models from provider: ${config.providerBaseUrl}`);

    const response = await axios.get(`${normalizeProviderBaseUrl(config.providerBaseUrl)}/models`, {
        timeout: 15_000,
        validateStatus: () => true
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Provider model list request failed with status ${response.status}`);
    }

    const data = Array.isArray(response.data?.data) ? response.data.data : [];
    const parsed = data
        .map((entry: unknown) => parseProviderModel(entry, {
            defaultModel: config.defaultModel
        }))
        .filter((model: CodexModelSummary | null): model is CodexModelSummary => model !== null);

    const filtered = filterPreferredProviderNamespace(parsed, config.defaultModel);

    logger.debug(`[codexModels] Provider returned ${filtered.length} models`);

    return filtered.length > 0 ? filtered : null;
}

// ---------------------------------------------------------------------------
// Baseline: codex app-server model listing (existing upstream logic)
// ---------------------------------------------------------------------------

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

async function listModelsFromAppServer(includeHidden: boolean): Promise<CodexModelSummary[]> {
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
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

// ---------------------------------------------------------------------------
// Public API — provider-first, app-server fallback
// ---------------------------------------------------------------------------

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
    // 1. Try provider-based listing first (reads ~/.codex/config.toml)
    try {
        const providerModels = await listModelsFromProvider();
        if (providerModels) {
            return providerModels;
        }
    } catch (error) {
        // Provider unavailable — fall through to app-server
        logger.debug('[codexModels] Provider listing failed, falling back to app-server:', error);
    }

    // 2. Fall back to codex app-server (baseline)
    try {
        return await listModelsFromAppServer(includeHidden);
    } catch (error) {
        throw new Error(getErrorMessage(error, 'Failed to list Codex models'));
    }
}
