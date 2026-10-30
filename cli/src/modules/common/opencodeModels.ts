import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asString, isObject } from '@hapi/protocol';
import type { OpencodeModelsResponse, OpencodeModelSummary } from '@hapi/protocol/apiTypes';
import { AcpStdioTransport } from '@/agent/backends/acp/AcpStdioTransport';
import packageJson from '../../../package.json';
import { getErrorMessage } from './rpcResponses';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';

export interface ListOpencodeModelsForCwdRequest {
    cwd?: string;
}

export type ListOpencodeModelsForCwdResponse = OpencodeModelsResponse;

export type OpencodeModelFilterMode = 'off' | 'allowlist' | 'blocklist';

export interface OpencodeModelFilter {
    mode: OpencodeModelFilterMode;
    models: Set<string>;
}

const FILTER_MODES: readonly OpencodeModelFilterMode[] = ['off', 'allowlist', 'blocklist'];

/** Env var overriding the filter file path (default: ~/.config/hapi/opencode-model-filter.json). */
export const OPENCODE_MODEL_FILTER_FILE_ENV = 'HAPI_OPENCODE_MODEL_FILTER_FILE';

export function defaultOpencodeModelFilterPath(): string {
    return join(homedir(), '.config', 'hapi', 'opencode-model-filter.json');
}

/**
 * Parse a filter document. Unknown modes, non-array model lists and malformed
 * documents degrade to `off` so discovery keeps its unfiltered default.
 */
export function parseOpencodeModelFilter(raw: unknown): OpencodeModelFilter {
    if (!isObject(raw)) {
        return { mode: 'off', models: new Set() };
    }

    const mode = asString(raw.mode);
    const filterMode = FILTER_MODES.includes(mode as OpencodeModelFilterMode)
        ? (mode as OpencodeModelFilterMode)
        : 'off';

    const models = new Set<string>();
    if (Array.isArray(raw.models)) {
        for (const entry of raw.models) {
            const modelId = asString(entry)?.trim();
            if (modelId) {
                models.add(modelId);
            }
        }
    }

    return { mode: filterMode, models };
}

/**
 * Load the model filter from disk. A missing or unreadable file (the default
 * state) keeps discovery unfiltered.
 */
export function loadOpencodeModelFilter(filePath?: string): OpencodeModelFilter {
    const path = filePath
        ?? process.env[OPENCODE_MODEL_FILTER_FILE_ENV]
        ?? defaultOpencodeModelFilterPath();

    try {
        return parseOpencodeModelFilter(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
        return { mode: 'off', models: new Set() };
    }
}

/**
 * Filter discovered models by exact modelId. An empty model list never hides
 * the whole catalog: it is treated as `off` so a half-written or cleared
 * configuration cannot make model selection unusable.
 */
export function applyOpencodeModelFilter(
    models: OpencodeModelSummary[],
    filter: OpencodeModelFilter
): OpencodeModelSummary[] {
    if (filter.mode === 'off' || filter.models.size === 0) {
        return models;
    }
    if (filter.mode === 'allowlist') {
        return models.filter((model) => filter.models.has(model.modelId));
    }
    return models.filter((model) => !filter.models.has(model.modelId));
}

interface CacheEntry {
    expiresAt: number;
    response: ListOpencodeModelsForCwdResponse;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ListOpencodeModelsForCwdResponse>>();

function normalizeAvailableModels(rawModels: unknown): OpencodeModelSummary[] {
    if (!Array.isArray(rawModels)) return [];
    const out: OpencodeModelSummary[] = [];
    for (const entry of rawModels) {
        if (!isObject(entry)) continue;
        const modelId = asString(entry.modelId) ?? asString(entry.value);
        if (!modelId) continue;
        const name = asString(entry.name) ?? undefined;
        out.push(name ? { modelId, name } : { modelId });
    }
    return out;
}

function extractModelConfigOption(response: Record<string, unknown>): {
    currentValue: string | null;
    options: unknown[];
} | null {
    if (!Array.isArray(response.configOptions)) return null;

    for (const entry of response.configOptions) {
        if (!isObject(entry)) continue;
        if (asString(entry.category) !== 'model') continue;
        return {
            currentValue: asString(entry.currentValue),
            options: Array.isArray(entry.options) ? entry.options : []
        };
    }

    return null;
}

function extractModelsFromResponse(response: unknown): {
    availableModels: OpencodeModelSummary[];
    currentModelId: string | null;
} {
    if (!isObject(response)) {
        return { availableModels: [], currentModelId: null };
    }

    const directList = response.availableModels;
    const directCurrent = response.currentModelId;
    const nested = isObject(response.models) ? response.models : null;
    const nestedList = nested?.availableModels;
    const nestedCurrent = nested?.currentModelId;

    const configModelOption = extractModelConfigOption(response);
    const rawModels = Array.isArray(directList)
        ? directList
        : Array.isArray(nestedList)
            ? nestedList
            : configModelOption?.options ?? null;
    const rawCurrent = typeof directCurrent === 'string'
        ? directCurrent
        : typeof nestedCurrent === 'string'
            ? nestedCurrent
            : configModelOption?.currentValue ?? null;

    return {
        availableModels: normalizeAvailableModels(rawModels),
        currentModelId: rawCurrent
    };
}

async function runOpencodeProbe(cwd: string): Promise<ListOpencodeModelsForCwdResponse> {
    const transport = await AcpStdioTransport.create({
        command: getAgentLaunchCommand('opencode'),
        args: ['acp']
    });

    try {
        const initResponse = await transport.sendRequest('initialize', {
            protocolVersion: 1,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false
            },
            clientInfo: {
                name: 'hapi-opencode-models',
                version: packageJson.version
            }
        }, { timeoutMs: PROBE_TIMEOUT_MS });

        if (!isObject(initResponse) || typeof initResponse.protocolVersion !== 'number') {
            return { success: false, error: 'Invalid initialize response from opencode acp' };
        }

        const newResponse = await transport.sendRequest('session/new', {
            cwd,
            mcpServers: []
        }, { timeoutMs: PROBE_TIMEOUT_MS });

        const { availableModels, currentModelId } = extractModelsFromResponse(newResponse);

        return {
            success: true,
            availableModels: applyOpencodeModelFilter(availableModels, loadOpencodeModelFilter()),
            currentModelId
        };
    } finally {
        await transport.close().catch(() => undefined);
    }
}

/**
 * Discover available OpenCode models for a given working directory by spawning
 * a short-lived `opencode acp` subprocess, sending `initialize` + `session/new`,
 * and capturing the `availableModels` / `currentModelId` snapshot from the
 * response. The subprocess is torn down immediately afterwards.
 *
 * The snapshot is filtered through `loadOpencodeModelFilter()` before caching,
 * so a local filter file (default `~/.config/hapi/opencode-model-filter.json`)
 * takes effect within one cache TTL without a restart.
 *
 * Results are cached per cwd for 60 seconds; concurrent requests for the same
 * cwd are coalesced via a single-flight promise so we never spawn more than
 * one probe at a time per cwd.
 */
export async function listOpencodeModelsForCwd(
    cwd: string
): Promise<ListOpencodeModelsForCwdResponse> {
    const trimmed = cwd?.trim();
    if (!trimmed) {
        return { success: false, error: 'cwd is required' };
    }

    const cached = cache.get(trimmed);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
    }

    const existing = inflight.get(trimmed);
    if (existing) {
        return existing;
    }

    const promise = (async () => {
        try {
            const response = await runOpencodeProbe(trimmed);
            if (response.success) {
                cache.set(trimmed, {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    response
                });
            }
            return response;
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover OpenCode models')
            } satisfies ListOpencodeModelsForCwdResponse;
        } finally {
            inflight.delete(trimmed);
        }
    })();

    inflight.set(trimmed, promise);
    return promise;
}

/**
 * Clear the in-process cache. Exposed for tests.
 */
export function _resetOpencodeModelsCacheForTests(): void {
    cache.clear();
    inflight.clear();
}
