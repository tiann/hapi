import axios from 'axios';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from './codexAppServerClient';
import type { ModelListResponse } from './appServerTypes';

type CodexModelReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

type CodexModelRecord = {
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    defaultReasoningEffort: CodexModelReasoningEffort;
    supportedReasoningEfforts: Array<{
        reasoningEffort: CodexModelReasoningEffort;
        description: string;
    }>;
    isDefault: boolean;
};

type CodexProviderConfig = {
    defaultModel: string | null;
    modelProvider: string | null;
    providerBaseUrl: string | null;
};

const DEFAULT_REASONING_EFFORT: CodexModelReasoningEffort = 'medium';
const DEFAULT_REASONING_OPTIONS: CodexModelRecord['supportedReasoningEfforts'] = [
    { reasoningEffort: 'none', description: 'Disable extra reasoning' },
    { reasoningEffort: 'minimal', description: 'Very light reasoning' },
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    { reasoningEffort: 'medium', description: 'Balanced reasoning depth for everyday tasks' },
    { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
    { reasoningEffort: 'xhigh', description: 'Maximum reasoning depth for hard problems' }
];

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

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

function normalizeProviderBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

function parseProviderModel(
    value: unknown,
    options: { defaultModel: string | null; providerLabel: string | null }
): CodexModelRecord | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }

    const id = asString(record.id);
    if (!id || !id.includes('/')) {
        return null;
    }

    return {
        id,
        model: id,
        displayName: id,
        description: options.providerLabel ? `Model from provider ${options.providerLabel}` : 'Model from configured provider',
        hidden: false,
        defaultReasoningEffort: DEFAULT_REASONING_EFFORT,
        supportedReasoningEfforts: DEFAULT_REASONING_OPTIONS,
        isDefault: id === options.defaultModel
    };
}

function filterPreferredProviderNamespace(
    models: CodexModelRecord[],
    defaultModel: string | null
): CodexModelRecord[] {
    if (!defaultModel || !defaultModel.includes('/')) {
        return models;
    }

    const namespace = `${defaultModel.split('/')[0]}/`;
    const scopedModels = models.filter((model) => model.model.startsWith(namespace));
    return scopedModels.length > 0 ? scopedModels : models;
}

async function listModelsFromProvider(): Promise<CodexModelRecord[] | null> {
    const config = await loadCodexProviderConfig();
    if (!config.providerBaseUrl) {
        return null;
    }

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
            defaultModel: config.defaultModel,
            providerLabel: config.modelProvider
        }))
        .filter((model: CodexModelRecord | null): model is CodexModelRecord => model !== null);

    const filtered = filterPreferredProviderNamespace(parsed, config.defaultModel);

    return filtered.length > 0 ? filtered : null;
}

function parseReasoningEffortOption(value: unknown): CodexModelRecord['supportedReasoningEfforts'][number] | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }

    const reasoningEffort = asString(record.reasoningEffort);
    const description = asString(record.description);
    if (!reasoningEffort || !description) {
        return null;
    }

    return {
        reasoningEffort: reasoningEffort as CodexModelReasoningEffort,
        description
    };
}

function parseModel(value: unknown): CodexModelRecord | null {
    const record = asRecord(value);
    if (!record) {
        return null;
    }

    const id = asString(record.id);
    const model = asString(record.model);
    const displayName = asString(record.displayName);
    const description = asString(record.description) ?? '';
    const hidden = asBoolean(record.hidden) ?? false;
    const defaultReasoningEffort = asString(record.defaultReasoningEffort);
    const isDefault = asBoolean(record.isDefault) ?? false;
    const supportedReasoningEffortsRaw = Array.isArray(record.supportedReasoningEfforts)
        ? record.supportedReasoningEfforts
        : [];

    if (!id || !model || !displayName || !defaultReasoningEffort) {
        return null;
    }

    return {
        id,
        model,
        displayName,
        description,
        hidden,
        defaultReasoningEffort: defaultReasoningEffort as CodexModelReasoningEffort,
        supportedReasoningEfforts: supportedReasoningEffortsRaw
            .map(parseReasoningEffortOption)
            .filter((option): option is NonNullable<typeof option> => option !== null),
        isDefault
    };
}

export async function listCodexModels(): Promise<{
    success: boolean;
    models?: CodexModelRecord[];
    error?: string;
}> {
    try {
        const providerModels = await listModelsFromProvider();
        if (providerModels) {
            return { success: true, models: providerModels };
        }
    } catch (error) {
        // Fall back to codex app-server when provider-specific listing is unavailable.
        void error;
    }

    const client = new CodexAppServerClient();

    try {
        await client.connect();
        await client.initialize({
            clientInfo: {
                name: 'hapi-codex-model-list',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        const response = await client.listModels() as ModelListResponse;
        const modelsRaw = Array.isArray(response?.data) ? response.data : [];
        const models = modelsRaw
            .map(parseModel)
            .filter((model): model is NonNullable<typeof model> => model !== null);

        return { success: true, models };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    } finally {
        await client.disconnect();
    }
}
