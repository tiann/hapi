import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeModelCachePath, prepareModelCatalogArgs, resolveModelCatalogArgs } from './modelCatalog';
import { sharedLaunchConfig } from '../shared/launch';

let directory: string;
let catalog: string;
beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hapi-model-catalog-'));
    catalog = join(directory, 'models with spaces.json');
    writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'test-model' }] }));
    vi.stubEnv('HAPI_CODEX_MODEL_CATALOG_JSON', catalog);
    vi.stubEnv('CODEX_HOME', directory);
});
afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
});

describe('HAPI Codex model catalog', () => {
    it('supports explicitly opting out of automatic catalog caching', () => {
        expect(resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_MODE: 'native' })).toEqual([]);
    });
    it('passes a validated absolute catalog as one TOML argument', () => {
        expect(resolveModelCatalogArgs()).toEqual(['-c', `model_catalog_json=${JSON.stringify(catalog)}`]);
    });
    it.each(['-c', '--config'])('keeps explicit %s catalog overrides authoritative', flag => {
        expect(resolveModelCatalogArgs([flag, 'model_catalog_json="explicit.json"'], {
            HAPI_CODEX_MODEL_CATALOG_JSON: '/missing/catalog.json'
        })).toEqual([]);
    });
    it('does not mistake another setting value for a catalog override', () => {
        expect(resolveModelCatalogArgs(['-c', 'model="model_catalog_json"'])).toHaveLength(2);
    });
    it.each(['not json', '{}', '{"models":[]}', '{"models":[{}]}'])('rejects unusable catalogs instead of silently going online: %s', contents => {
        writeFileSync(catalog, contents);
        expect(() => resolveModelCatalogArgs()).toThrow('HAPI_CODEX_MODEL_CATALOG_JSON');
    });
    it('rejects missing and relative paths before spawning a server', () => {
        expect(() => resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_JSON: '/missing/catalog.json' })).toThrow('HAPI_CODEX_MODEL_CATALOG_JSON');
        expect(() => resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_JSON: 'models.json' })).toThrow('absolute');
    });
    it('does not override explicit shared server configuration', () => {
        const result = sharedLaunchConfig({ codexArgs: ['--config=model_catalog_json="explicit.json"'] }, directory);
        expect(result.serverArgs).toEqual(['--config', 'model_catalog_json="explicit.json"']);
    });
    it.each([
        ['linux', '/home/alice', {}, '/home/alice/.codex/models_cache.json'],
        ['darwin', '/Users/alice', {}, '/Users/alice/.codex/models_cache.json'],
        ['win32', 'C:\\Users\\Alice', {}, 'C:\\Users\\Alice\\.codex\\models_cache.json'],
        ['win32', 'C:\\Users\\Alice', { CODEX_HOME: 'D:\\Agent Data\\Codex' }, 'D:\\Agent Data\\Codex\\models_cache.json'],
        ['win32', 'C:\\Users\\Alice', { CODEX_HOME: '\\\\server\\share\\Codex' }, '\\\\server\\share\\Codex\\models_cache.json'],
        ['darwin', '/Users/alice', { CODEX_HOME: '~/Agent Data' }, '/Users/alice/Agent Data/models_cache.json']
    ] as const)('resolves the current machine catalog on %s', (platform, home, env, expected) => {
        expect(nativeModelCachePath(env, home, platform)).toBe(expected);
    });
});

const model = { slug: 'validated-model', display_name: 'Validated', supported_reasoning_levels: [] };
const command = { command: 'codex', args: [] as string[] };
function automaticEnv() { return { CODEX_HOME: directory }; }
function authenticate() {
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fake', account_id: 'account-a' } }));
}
function probe(config: Record<string, unknown> = {}) {
    return vi.fn(async (_command: typeof command, args: string[], env: NodeJS.ProcessEnv, _cwd?: string, listModels?: boolean) => {
        if (listModels && !args.some(arg => arg.startsWith('model_catalog_json='))) {
            writeFileSync(join(env.CODEX_HOME!, 'models_cache.json'), JSON.stringify({ models: [model] }));
        }
        return { config, version: 'test-version' };
    });
}

describe('verified automatic catalog provenance', () => {
    beforeEach(authenticate);
    it('bootstraps in an isolated home and reuses a schema-validated snapshot', async () => {
        const discover = probe();
        const first = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        const second = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        expect(first).toEqual(second);
        expect(first[1]).toContain('hapi-model-catalogs');
        expect(discover.mock.calls.filter(call => call[4])).toHaveLength(2);
        expect(discover.mock.calls[1][2].CODEX_HOME).not.toBe(directory);
    });
    it('coordinates concurrent bootstrap requests', async () => {
        const discover = probe();
        const results = await Promise.all(Array.from({ length: 4 }, () => prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover)));
        expect(results.every(value => JSON.stringify(value) === JSON.stringify(results[0]))).toBe(true);
        expect(discover.mock.calls.filter(call => call[4])).toHaveLength(2);
    });
    it.each([
        { model_provider: 'custom' },
        { model_providers: { openai: { env_key: 'CUSTOM_KEY' } } },
        { cli_auth_credentials_store: 'keyring' },
        { model_catalog_json: 'custom.json' }
    ])('preserves effective native configuration: %j', async config => {
        writeFileSync(join(directory, 'models_cache.json'), JSON.stringify({ models: [model] }));
        writeFileSync(join(directory, 'config.toml'), 'model_catalog_json = "custom.json"');
        const discover = probe(config);
        expect(await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover)).toEqual([]);
        expect(discover).toHaveBeenCalledTimes(1);
    });
    it.each(['OPENAI_API_KEY', 'CODEX_API_KEY'])('retains native behavior for changed %s without touching auth.json', async key => {
        const discover = probe();
        await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        expect(await prepareModelCatalogArgs(command, [], { ...automaticEnv(), [key]: 'changed' }, directory, discover)).toEqual([]);
        expect(discover.mock.calls.filter(call => call[4])).toHaveLength(2);
    });
    it('invalidates after endpoint or arbitrary credential environment changes', async () => {
        const discover = probe();
        const first = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        const second = await prepareModelCatalogArgs(command, [], { ...automaticEnv(), CUSTOM_AUTH_TOKEN: 'changed' }, directory, discover);
        const third = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, probe({ chatgpt_base_url: 'https://other.example' }));
        expect(new Set([first[1], second[1], third[1]]).size).toBe(3);
    });
    it('does not adopt a slug-only native cache and falls back on native schema rejection', async () => {
        writeFileSync(join(directory, 'models_cache.json'), '{"models":[{"slug":"bad"}]}');
        const discover = probe();
        discover.mockImplementation(async (_command, args, env, _cwd, listModels) => {
            if (args.some(arg => arg.startsWith('model_catalog_json='))) throw new Error('missing display_name');
            if (listModels) writeFileSync(join(env.CODEX_HOME!, 'models_cache.json'), '{"models":[{"slug":"bad"}]}');
            return { config: {}, version: 'test-version' };
        });
        const warn = vi.fn();
        expect(await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover, warn)).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing display_name'));
    });
    it('revalidates modified HAPI snapshots instead of trusting old stamps', async () => {
        const discover = probe();
        const args = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        const file = JSON.parse(args[1].slice('model_catalog_json='.length));
        writeFileSync(file, '{"models":[{"slug":"bad"}]}');
        await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        expect(discover.mock.calls.filter(call => call[4])).toHaveLength(4);
    });
    it('invalidates after credentials change without relying on file timestamps', async () => {
        const discover = probe();
        const first = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        writeFileSync(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'new', account_id: 'account-b' } }));
        const second = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        expect(second[1]).not.toBe(first[1]);
    });
    it('refreshes an expired validation stamp', async () => {
        const discover = probe();
        const args = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        const file = JSON.parse(args[1].slice('model_catalog_json='.length)) + '.validated';
        const stamp = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(file, JSON.stringify({ ...stamp, at: Date.now() - 25 * 60 * 60 * 1000 }));
        await prepareModelCatalogArgs(command, [], automaticEnv(), directory, discover);
        expect(discover.mock.calls.filter(call => call[4])).toHaveLength(4);
    });
    it('does not treat reordered effective configuration fields as a change', async () => {
        const first = await prepareModelCatalogArgs(command, [], automaticEnv(), directory, probe({ model: 'a', features: {} }));
        const next = probe({ features: {}, model: 'a' });
        expect(await prepareModelCatalogArgs(command, [], automaticEnv(), directory, next)).toEqual(first);
        expect(next).toHaveBeenCalledTimes(1);
    });
    it('never probes in explicit native mode', async () => {
        const discover = probe();
        expect(await prepareModelCatalogArgs(command, [], { ...automaticEnv(), HAPI_CODEX_MODEL_CATALOG_MODE: 'native' }, directory, discover)).toEqual([]);
        expect(discover).not.toHaveBeenCalled();
    });
});
