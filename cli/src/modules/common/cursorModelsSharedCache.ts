import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CursorModelsResponse } from '@hapi/protocol/apiTypes';

function getHapiHomeDir(): string {
    return process.env.HAPI_HOME?.trim() || join(tmpdir(), 'hapi');
}

function getSharedCachePath(): string {
    return join(getHapiHomeDir(), 'cache', 'cursor-models.json');
}

function isUsableModelsResponse(response: CursorModelsResponse | null): response is CursorModelsResponse {
    return Boolean(
        response?.success
        && (response.availableModels?.length ?? 0) > 0
    );
}

/** Cross-process catalog for New Session while an ACP lock blocks `agent --list-models`. */
export function readSharedCursorModelsCache(): CursorModelsResponse | null {
    const path = getSharedCachePath();
    if (!existsSync(path)) {
        return null;
    }

    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as CursorModelsResponse;
        return isUsableModelsResponse(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function writeSharedCursorModelsCache(response: CursorModelsResponse): void {
    if (!isUsableModelsResponse(response)) {
        return;
    }

    const path = getSharedCachePath();
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(response), 'utf8');
    } catch {
        // Best effort — in-process cache still works in the session child.
    }
}

export function _resetSharedCursorModelsCacheForTests(): void {
    const path = getSharedCachePath();
    if (existsSync(path)) {
        rmSync(path, { force: true });
    }
}
