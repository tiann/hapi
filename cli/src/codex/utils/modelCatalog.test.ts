import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    it('applies the same catalog to new and resumed shared servers', () => {
        for (const options of [{}, { resumeSessionId: 'existing-thread' }]) {
            const result = sharedLaunchConfig(options, directory);
            expect(result.serverArgs).toContain(`model_catalog_json=${JSON.stringify(catalog)}`);
            expect(result.tuiArgs).not.toContain(`model_catalog_json=${JSON.stringify(catalog)}`);
        }
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
    it('uses an existing native cache by default without any discovery process', async () => {
        const file = join(directory, 'models_cache.json');
        writeFileSync(file, JSON.stringify({ models: [{ slug: 'cached' }] }));
        const discover = vi.fn();
        const args = await prepareModelCatalogArgs({ command: 'codex', args: [] }, [], { CODEX_HOME: directory }, directory, discover);
        expect(args).toEqual(['-c', `model_catalog_json=${JSON.stringify(file)}`]);
        expect(discover).not.toHaveBeenCalled();
    });
    it.each([false, true])('bootstraps a missing/damaged cache once across concurrent sessions (damaged=%s)', async damaged => {
        const file = join(directory, 'models_cache.json');
        if (damaged) writeFileSync(file, '{');
        const discover = vi.fn(async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            writeFileSync(file, JSON.stringify({ models: [{ slug: 'discovered' }] }));
        });
        const results = await Promise.all(Array.from({ length: 4 }, () =>
            prepareModelCatalogArgs({ command: 'codex', args: [] }, [], { CODEX_HOME: directory }, directory, discover)));
        expect(discover).toHaveBeenCalledTimes(1);
        expect(results.every(args => args[1] === `model_catalog_json=${JSON.stringify(file)}`)).toBe(true);
    });
    it('preserves native behavior with a warning when first discovery cannot produce a cache', async () => {
        const warn = vi.fn();
        const result = await prepareModelCatalogArgs({ command: 'codex', args: [] }, [], { CODEX_HOME: directory }, directory, async () => {}, warn);
        expect(result).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('using native discovery'));
    });
    it('never bootstraps when native mode is explicitly selected', async () => {
        const discover = vi.fn();
        expect(await prepareModelCatalogArgs({ command: 'codex', args: [] }, [], {
            CODEX_HOME: directory, HAPI_CODEX_MODEL_CATALOG_MODE: 'native'
        }, directory, discover)).toEqual([]);
        expect(discover).not.toHaveBeenCalled();
    });
    it.each(['expired', 'new-login'])('refreshes the shared cache on startup after %s', async reason => {
        const file = join(directory, 'models_cache.json');
        writeFileSync(file, JSON.stringify({ models: [{ slug: 'old' }] }));
        const old = new Date(Date.now() - (reason === 'expired' ? 25 * 60 * 60 * 1000 : 1000));
        utimesSync(file, old, old);
        if (reason === 'new-login') writeFileSync(join(directory, 'auth.json'), '{}');
        const discover = vi.fn(async () => { writeFileSync(file, JSON.stringify({ models: [{ slug: 'fresh' }] })); });
        expect(await prepareModelCatalogArgs({ command: 'codex', args: [] }, [], { CODEX_HOME: directory }, directory, discover))
            .toEqual(['-c', `model_catalog_json=${JSON.stringify(file)}`]);
        expect(discover).toHaveBeenCalledTimes(1);
    });
});
