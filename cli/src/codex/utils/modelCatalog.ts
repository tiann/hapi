import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
    // Automatic selection requires native config/schema validation and is asynchronous.
    if (!configured?.trim()) { nativeMode(env); return []; }
    const file = configured.startsWith('~/') || configured.startsWith('~\\')
        ? path.join(homedir(), configured.slice(2)) : configured;
    if (!path.isAbsolute(file)) throw new Error('HAPI_CODEX_MODEL_CATALOG_JSON must be an absolute path (or start with ~/).');
    try {
        validateCatalog(file);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot load HAPI_CODEX_MODEL_CATALOG_JSON (${file}): ${detail}`);
    }
    return ['-c', `model_catalog_json=${JSON.stringify(file)}`];
}

/** One bounded discovery process, before any user thread or turn exists. */
export interface CatalogProbeResult {
    config: Record<string, unknown>;
    version: unknown;
}

async function discoverCatalog(command: CodexCommand, args: string[], env: NodeJS.ProcessEnv, cwd?: string, listModels = false): Promise<CatalogProbeResult> {
    const child = spawn(command.command, [...command.args, 'app-server', ...args], {
        cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
    });
    const lines = createInterface({ input: child.stdout });
    try {
        return await new Promise<CatalogProbeResult>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('model discovery timed out')), 8_000);
            let config: Record<string, unknown> = {};
            let version: unknown;
            const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve({ config, version }); };
            child.once('error', finish);
            child.once('exit', () => finish(new Error('model discovery exited early')));
            child.stdin.on('error', finish);
            lines.on('line', line => {
                try {
                    const response = JSON.parse(line);
                    if (response.error) { finish(new Error(`Codex rejected model discovery: ${response.error.message ?? 'unknown error'}`)); return; }
                    if (response.id === 1) {
                        version = response.result;
                        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
                        child.stdin.write(JSON.stringify({ id: 2, method: 'config/read', params: { cwd, includeLayers: false } }) + '\n');
                    } else if (response.id === 2) {
                        if (!response.result?.config || typeof response.result.config !== 'object') {
                            finish(new Error('Codex did not return effective configuration')); return;
                        }
                        config = response.result.config;
                        if (listModels) child.stdin.write(JSON.stringify({ id: 3, method: 'model/list', params: { includeHidden: true } }) + '\n');
                        else finish();
                    } else if (response.id === 3) finish();
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

function digest(value: unknown): string {
    // Native config maps do not guarantee property order across processes.
    const canonical = (item: unknown): unknown => {
        if (Array.isArray(item)) return item.map(canonical);
        if (item && typeof item === 'object') return Object.fromEntries(
            Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])
        );
        return item;
    };
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function catalogArgs(file: string): string[] {
    return ['-c', `model_catalog_json=${JSON.stringify(file)}`];
}

/** Auto mode is deliberately limited to reproducible, file-backed first-party credentials.
 * Other providers/keyrings/command auth retain Codex's native identity checks. */
function eligible(config: Record<string, unknown>, env: NodeJS.ProcessEnv, auth: string): boolean {
    if (config.model_provider && config.model_provider !== 'openai') return false;
    if (config.model_providers && Object.keys(config.model_providers as object).length) return false;
    if (config.cli_auth_credentials_store && config.cli_auth_credentials_store !== 'file') return false;
    if (env.CODEX_API_KEY || env.OPENAI_API_KEY || env.CODEX_ACCESS_TOKEN) return false;
    try {
        const value = JSON.parse(auth);
        return value.auth_mode === 'chatgpt' && typeof value.tokens?.access_token === 'string'
            && typeof value.tokens?.account_id === 'string';
    } catch { return false; }
}

export async function prepareModelCatalogArgs(
    command: CodexCommand,
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env,
    cwd?: string,
    discover: typeof discoverCatalog = discoverCatalog,
    warn: (message: string) => void = console.warn
): Promise<string[]> {
    const explicit = resolveModelCatalogArgs(args, env);
    if (explicitCatalog(args)) return [];
    if (explicit.length) {
        // Let the selected executable validate its complete schema, including nested fields.
        await discover(command, [...args, ...explicit], env, cwd, true);
        return explicit;
    }
    if (nativeMode(env)) return [];
    const home = path.dirname(nativeModelCachePath(env));
    let temporary: string | undefined;
    try {
        // Codex resolves profiles, project/system config and launch overrides for us.
        const current = await discover(command, args, env, cwd);
        if (current.config.model_catalog_json) return [];
        const auth = await readFile(path.join(home, 'auth.json'), 'utf8').catch(() => '');
        if (!eligible(current.config, env, auth)) return [];
        const configFile = await readFile(path.join(home, 'config.toml'), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return '';
            throw error;
        });
        // Hash every environment entry: custom credential/header variables must invalidate too.
        // No credentials or environment values are persisted in the provenance record.
        const key = digest([command, current, args, cwd, configFile, auth,
            Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))]);
        const directory = path.join(home, 'hapi-model-catalogs');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, `${key}.json`);
        const stamp = `${file}.validated`;
        const refresh = () => withSettingsFileLock(file, async () => {
            try {
                const contents = await readFile(file, 'utf8');
                const validation = JSON.parse(await readFile(stamp, 'utf8'));
                if (validation.digest === digest(contents) && Date.now() - validation.at < MAX_CACHE_AGE_MS) {
                    return catalogArgs(file);
                }
            } catch { /* Missing, damaged or unvalidated HAPI snapshots are cache misses. */ }
            // A separate home prevents another Codex/provider from replacing the cache between
            // discovery and snapshotting. Never promote an unscoped pre-existing native cache.
            temporary = await mkdtemp(path.join(home, '.hapi-model-discovery-'));
            await writeFile(path.join(temporary, 'auth.json'), auth, { mode: 0o600 });
            await writeFile(path.join(temporary, 'config.toml'), configFile, { mode: 0o600 });
            const isolatedEnv = { ...env, CODEX_HOME: temporary };
            const discovered = await discover(command, args, isolatedEnv, cwd, true);
            if (discovered.config.model_catalog_json || !eligible(discovered.config, isolatedEnv, auth)
                || digest(discovered.config) !== digest(current.config)) {
                throw new Error('Discovery configuration is not eligible for automatic catalogs');
            }
            const candidate = path.join(temporary, 'models_cache.json');
            validateCatalog(candidate);
            // Native schema check: a slug-only or otherwise invalid catalog cannot become authoritative.
            await discover(command, [...args, ...catalogArgs(candidate)], isolatedEnv, cwd, true);
            // An auth/config change during discovery must not bind the result to the old context.
            if (await readFile(path.join(home, 'auth.json'), 'utf8') !== auth
                || await readFile(path.join(home, 'config.toml'), 'utf8').catch(() => '') !== configFile) {
                throw new Error('Codex credentials/configuration changed during discovery');
            }
            const contents = await readFile(candidate, 'utf8');
            await writeFile(file, contents, { mode: 0o600 });
            await writeFile(stamp, JSON.stringify({ digest: digest(contents), at: Date.now() }), { mode: 0o600 });
            return catalogArgs(file);
        });
        try { return await refresh(); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
            return await refresh();
        }
    } catch (error) {
        warn(`[HAPI] Local Codex model catalog unavailable; using native discovery: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
    }
}
