import { homedir } from 'node:os';
import path from 'node:path';

const CATALOG_KEY = /^\s*(?:model_catalog_json|"model_catalog_json"|'model_catalog_json')\s*=/;

/** Pass an explicit HAPI setting to Codex. Catalog contents and lifecycle belong to Codex. */
export function resolveModelCatalogArgs(
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env,
    userHome = homedir(),
    platform: NodeJS.Platform = process.platform
): string[] {
    // Shared launch flags are normalized before this helper runs.
    if (args.some((arg, index) => (arg === '-c' || arg === '--config') && CATALOG_KEY.test(args[index + 1] ?? ''))) return [];
    const configured = env.HAPI_CODEX_MODEL_CATALOG_JSON;
    if (!configured?.trim()) return [];
    const paths = platform === 'win32' ? path.win32 : path.posix;
    const file = configured.startsWith('~/') || configured.startsWith('~\\')
        ? paths.join(userHome, configured.slice(2)) : configured;
    if (!paths.isAbsolute(file)) {
        throw new Error('HAPI_CODEX_MODEL_CATALOG_JSON must be an absolute path (or start with ~/).');
    }
    return ['-c', `model_catalog_json=${JSON.stringify(file)}`];
}
