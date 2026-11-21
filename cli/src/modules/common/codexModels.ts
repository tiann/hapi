import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { CodexModelsResponse, CodexModelSummary } from '@hapi/protocol/apiTypes';
import { CodexAppServerClient, resolveCodexAppServerCommand } from '@/codex/codexAppServerClient';
import { resolveModelCatalogArgs } from '@/codex/utils/modelCatalog';
import { resolveCodexHome } from '@/codex/utils/codexHome';
import { probeCodexCliVersion, resolveCodexCommand, type CodexCommand } from '@/codex/utils/codexExecutable';
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
        const id = typeof record.id === 'string' ? record.id : undefined;
        const name = asNonEmptyString(record.name);
        if (id) tokens.add(id);
        // Ultrafast eligibility requires its native request ID, never a label.
        if (name && name.toLowerCase() !== 'ultrafast') tokens.add(name.toLowerCase());
    }

    return tokens.size > 0 ? [...tokens] : undefined;
}

export function normalizeCodexModel(entry: unknown, canVerifyUltrafast = true): CodexModelSummary | null {
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
        serviceTiers: normalizeServiceTiers(record.serviceTiers)?.filter(tier => canVerifyUltrafast || tier !== 'ultrafast')
    };
}

interface CacheEntry {
    expiresAt: number;
    fingerprint: string;
    models: CodexModelSummary[];
}

// A model lookup starts a fresh app-server. Keep successful discovery for a
// day, but discard it when local auth, config, the configured model catalog,
// or either Codex executable changes. Checks run only on model lookups.
const CACHE_TTL_MS = 24 * 60 * 60_000;
const cache = new Map<boolean, CacheEntry>();
const inflight = new Map<boolean, { fingerprint: string; promise: Promise<CodexModelSummary[]> }>();

async function readOptionalFile(path: string): Promise<Buffer | null> {
    try {
        return await readFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

async function catalogFingerprint(): Promise<string> {
    const home = resolveCodexHome();
    const config = await readOptionalFile(join(home, 'config.toml'));
    const auth = await readOptionalFile(join(home, 'auth.json'));
    const rootConfig = config?.toString('utf8').split(/^\s*\[/m, 1)[0] ?? '';
    const rawPath = rootConfig.match(/^\s*model_catalog_json\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/m)?.[1];
    let catalogPath: string | undefined;
    const override = resolveModelCatalogArgs();
    if (override.length) {
        catalogPath = JSON.parse(override[1].slice('model_catalog_json='.length)) as string;
    } else if (rawPath) {
        catalogPath = rawPath.startsWith('"') ? JSON.parse(rawPath) as string : rawPath.slice(1, -1);
    }
    const catalog = catalogPath ? await readOptionalFile(resolve(home, catalogPath)) : null;
    const hash = createHash('sha256');
    for (const value of [home, config, auth, catalogPath, catalog]) {
        hash.update(value === null || value === undefined ? 'missing' : value);
        hash.update('\0');
    }
    return hash.digest('hex');
}

export async function listCodexModels(includeHidden: boolean = false): Promise<CodexModelSummary[]> {
    // Desktop discovery can use a different binary. The shared Runner's
    // actual executable must also understand effective Ultrafast settings.
    const runnerCommand = resolveCodexCommand();
    const [catalogKey, runnerVersion, discovery] = await Promise.all([
        catalogFingerprint(), probeCodexCliVersion(runnerCommand), resolveCodexAppServerCommand(homedir())
    ]);
    const discoveryCommand = discovery.command;
    const runnerKey = JSON.stringify(runnerCommand);
    const discoveryKey = JSON.stringify(discoveryCommand);
    const discoveryVersion = discovery.version !== undefined
        ? discovery.version
        : discoveryKey === runnerKey && isAbsolute(discoveryCommand.command)
            ? runnerVersion
            : await probeCodexCliVersion(discoveryCommand, homedir());
    const fingerprint = JSON.stringify([catalogKey, runnerKey, runnerVersion, discoveryKey, discoveryVersion]);
    const cached = cache.get(includeHidden);
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) {
        return cached.models;
    }

    const existing = inflight.get(includeHidden);
    if (existing?.fingerprint === fingerprint) {
        return existing.promise;
    }

    const runnerSupportsUltrafast = Boolean(runnerVersion && (runnerVersion[0] > 0 || runnerVersion[1] >= 170));
    const promise = fetchCodexModelsFromAppServer(includeHidden, runnerSupportsUltrafast, discoveryCommand)
        .then((models) => {
            if (models.length > 0 && inflight.get(includeHidden)?.promise === promise) {
                cache.set(includeHidden, {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    fingerprint,
                    models
                });
            }
            return models;
        })
        .finally(() => {
            if (inflight.get(includeHidden)?.promise === promise) inflight.delete(includeHidden);
        });

    inflight.set(includeHidden, { fingerprint, promise });
    return promise;
}

async function fetchCodexModelsFromAppServer(
    includeHidden: boolean,
    runnerSupportsUltrafast: boolean,
    command: CodexCommand
): Promise<CodexModelSummary[]> {
    // Model discovery is account-scoped. Never inherit a session/runner cwd:
    // project config or a deleted worktree must not alter or break the catalog.
    const client = new CodexAppServerClient({ cwd: homedir(), command });

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
        const canVerifyUltrafast = runnerSupportsUltrafast && client.supportsEffectiveUltrafastLaunch();
        return Array.isArray(response.data)
            ? response.data.map(entry => normalizeCodexModel(entry, canVerifyUltrafast)).filter((model): model is CodexModelSummary => model !== null)
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
