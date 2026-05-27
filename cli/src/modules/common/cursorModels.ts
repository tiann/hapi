import { spawn } from 'node:child_process';
import type { CursorModelsResponse, CursorModelSummary } from '@hapi/protocol/apiTypes';
import { getErrorMessage } from './rpcResponses';

export type ListCursorModelsResponse = CursorModelsResponse;

interface CacheEntry {
    expiresAt: number;
    response: ListCursorModelsResponse;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const cache: CacheEntry = {
    expiresAt: 0,
    response: { success: true, availableModels: [], currentModelId: null }
};
let inflight: Promise<ListCursorModelsResponse> | null = null;

export function parseCursorModelsOutput(output: string): {
    availableModels: CursorModelSummary[];
    currentModelId: string | null;
} {
    const availableModels: CursorModelSummary[] = [];
    let currentModelId: string | null = null;

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line === 'Available models' || line.startsWith('Tip:')) {
            continue;
        }

        const separatorIndex = line.indexOf(' - ');
        if (separatorIndex <= 0) {
            continue;
        }

        const modelId = line.slice(0, separatorIndex).trim();
        const rawName = line.slice(separatorIndex + 3).trim();
        if (!modelId || !rawName) {
            continue;
        }

        const isCurrent = /\s*\(current\)\s*$/.test(rawName);
        const isDefault = /\s*\(default\)\s*$/.test(rawName);
        const name = rawName.replace(/\s*\((?:current|default)\)\s*$/, '').trim();
        availableModels.push(name && name !== modelId ? { modelId, name } : { modelId });

        if (isCurrent) {
            currentModelId = modelId;
        } else if (isDefault && currentModelId === null) {
            currentModelId = modelId;
        }
    }

    return { availableModels, currentModelId };
}

async function runCursorModelProbe(): Promise<ListCursorModelsResponse> {
    return await new Promise((resolve, reject) => {
        const child = spawn('agent', ['--list-models'], {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            reject(new Error('Cursor model discovery timed out'));
        }, PROBE_TIMEOUT_MS);

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `agent --list-models exited with code ${code}`));
                return;
            }

            resolve({
                success: true,
                ...parseCursorModelsOutput(stdout)
            });
        });
    });
}

export async function listCursorModels(): Promise<ListCursorModelsResponse> {
    if (cache.expiresAt > Date.now()) {
        return cache.response;
    }

    if (inflight) {
        return inflight;
    }

    inflight = (async () => {
        try {
            const response = await runCursorModelProbe();
            cache.expiresAt = Date.now() + CACHE_TTL_MS;
            cache.response = response;
            return response;
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover Cursor models')
            };
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

export function _resetCursorModelsCacheForTests(): void {
    cache.expiresAt = 0;
    cache.response = { success: true, availableModels: [], currentModelId: null };
    inflight = null;
}
