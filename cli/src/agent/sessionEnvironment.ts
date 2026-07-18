import os from 'node:os';
import { delimiter, join } from 'node:path';

function getHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.HOME?.trim() || os.homedir();
}

export function prependPathEntry(pathValue: string | undefined, entry: string): string {
    const parts = (pathValue ?? '')
        .split(delimiter)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    if (parts.includes(entry)) {
        return parts.join(delimiter);
    }

    return [entry, ...parts].join(delimiter);
}

export function buildHapiSessionEnvironment(
    sessionId: string,
    env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
    const localBin = join(getHome(env), '.local', 'bin');

    return {
        HAPI_SESSION_ID: sessionId,
        CODEX_HANDOFF_CALLER_TAG: sessionId,
        PATH: prependPathEntry(env.PATH, localBin),
    };
}

export function applyHapiSessionEnvironment(
    sessionId: string,
    env: NodeJS.ProcessEnv = process.env
): void {
    Object.assign(env, buildHapiSessionEnvironment(sessionId, env));
}
