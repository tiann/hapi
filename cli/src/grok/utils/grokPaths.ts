import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export function getGrokHome(env: NodeJS.ProcessEnv = process.env): string {
    return env.GROK_HOME?.trim() || join(homedir(), '.grok');
}

export function normalizeGrokCwd(cwd: string): string {
    const absolute = isAbsolute(cwd) ? cwd : resolve(cwd);
    try {
        return realpathSync.native(absolute);
    } catch {
        if (process.platform === 'darwin' && absolute.startsWith('/tmp/')) {
            return `/private${absolute}`;
        }
        return absolute;
    }
}

export function encodeGrokCwd(cwd: string): string {
    return encodeURIComponent(normalizeGrokCwd(cwd));
}

export function getGrokSessionDir(opts: { grokHome?: string; cwd: string; sessionId: string }): string {
    return join(opts.grokHome ?? getGrokHome(), 'sessions', encodeGrokCwd(opts.cwd), opts.sessionId);
}
