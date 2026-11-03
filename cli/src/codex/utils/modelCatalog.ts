import { readFileSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { withSettingsFileLock } from '@hapi/protocol/settingsFileLock';
import type { CodexCommand } from './codexExecutable';

const CATALOG_KEY = /^\s*(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=/;
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;

export function nativeModelCachePath(
    env: NodeJS.ProcessEnv = process.env,
    userHome = homedir(),
    platform: NodeJS.Platform = process.platform
): string {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const configured = env.CODEX_HOME;
    const home = configured?.startsWith('~/') || configured?.startsWith('~\\')
        ? paths.join(userHome, configured.slice(2)) : configured || paths.join(userHome, '.codex');
    return paths.join(paths.resolve(home), 'models_cache.json');
}

function explicitCatalog(args: string[]): boolean {
    return args.some((arg, index) => (arg === '-c' || arg === '--config') && CATALOG_KEY.test(args[index + 1] ?? ''));
}

function nativeMode(env: NodeJS.ProcessEnv): boolean {
    const mode = env.HAPI_CODEX_MODEL_CATALOG_MODE?.trim() || 'auto';
    if (mode !== 'auto' && mode !== 'native') throw new Error('HAPI_CODEX_MODEL_CATALOG_MODE must be auto or native.');
    return mode === 'native';
}

function validateCatalog(file: string): void {
    const catalog: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const models = catalog && typeof catalog === 'object' && 'models' in catalog ? catalog.models : undefined;
    if (!Array.isArray(models) || models.length === 0 || models.some(model =>
        !model || typeof model !== 'object' || typeof model.slug !== 'string' || !model.slug.trim())) {
        throw new Error('expected a non-empty models array with model slugs');
    }
}

/** args contains normalized app-server flags. Explicit launch config wins over HAPI. */
export function resolveModelCatalogArgs(args: string[] = [], env: NodeJS.ProcessEnv = process.env): string[] {
    if (explicitCatalog(args)) return [];
    const configured = env.HAPI_CODEX_MODEL_CATALOG_JSON;
    if (!configured?.trim() && nativeMode(env)) return [];
    const file = configured?.trim()
        ? configured.startsWith('~/') || configured.startsWith('~\\')
            ? path.join(homedir(), configured.slice(2)) : configured
        : nativeModelCachePath(env);
    if (!path.isAbsolute(file)) throw new Error('HAPI_CODEX_MODEL_CATALOG_JSON must be an absolute path (or start with ~/).');
    try {
        validateCatalog(file);
        if (!configured?.trim()) {
            const cachedAt = statSync(file).mtimeMs;
            if (Date.now() - cachedAt > MAX_CACHE_AGE_MS) return [];
            // A login/account change must not pin the previous account's catalog.
            try {
                if (statSync(path.join(path.dirname(file), 'auth.json')).mtimeMs > cachedAt) return [];
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
    } catch (error) {
        // Auto mode can bootstrap a missing/damaged cache. An explicit path is never silently ignored.
        if (!configured?.trim()) return [];
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot load HAPI_CODEX_MODEL_CATALOG_JSON (${file}): ${detail}`);
    }
    return ['-c', `model_catalog_json=${JSON.stringify(file)}`];
}

/** One bounded discovery process, before any user thread or turn exists. */
async function discoverCatalog(command: CodexCommand, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
    const child = spawn(command.command, [...command.args, 'app-server', ...args], {
        cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
    });
    const lines = createInterface({ input: child.stdout });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('model discovery timed out')), 8_000);
            const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
            child.once('error', finish);
            child.once('exit', () => finish(new Error('model discovery exited early')));
            child.stdin.on('error', finish);
            lines.on('line', line => {
                try {
                    const response = JSON.parse(line);
                    if (response.error) { finish(new Error('Codex rejected model discovery')); return; }
                    if (response.id === 1) {
                        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
                        child.stdin.write(JSON.stringify({ id: 2, method: 'model/list', params: { includeHidden: true } }) + '\n');
                    } else if (response.id === 2) finish();
                } catch { finish(new Error('Invalid model discovery response')); }
            });
            child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: {
                clientInfo: { name: 'hapi-catalog-bootstrap', version: '1' }, capabilities: null
            } }) + '\n');
        });
    } finally {
        lines.close();
        // No turns/MCP children are created. Reap this short-lived child before launching the real engine.
        if (child.exitCode === null && child.signalCode === null && child.pid) {
            child.kill();
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
    }
}

export async function prepareModelCatalogArgs(
    command: CodexCommand,
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env,
    cwd?: string,
    discover: typeof discoverCatalog = discoverCatalog,
    warn: (message: string) => void = console.warn
): Promise<string[]> {
    const ready = resolveModelCatalogArgs(args, env);
    if (ready.length || explicitCatalog(args) || nativeMode(env)) return ready;
    const file = nativeModelCachePath(env);
    try {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        // Cross-process lock: simultaneous sessions recheck the cache after the first writer finishes.
        const refresh = () => withSettingsFileLock(file, async () => {
            const cached = resolveModelCatalogArgs(args, env);
            if (cached.length) return cached;
            await discover(command, args, { ...env, CODEX_HOME: path.dirname(file) }, cwd);
            const fresh = resolveModelCatalogArgs(args, env);
            if (!fresh.length) throw new Error('Codex did not produce a usable model cache');
            return fresh;
        });
        // The shared lock waits five seconds; a cold discovery may take up to eight.
        // Retry lock contention rather than starting a competing native engine mid-refresh.
        try { return await refresh(); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
            return await refresh();
        }
    } catch (error) {
        // Offline/API-key/custom-provider setups may not expose a catalog. Preserve native behavior visibly.
        warn(`[HAPI] Local Codex model catalog unavailable; using native discovery: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
