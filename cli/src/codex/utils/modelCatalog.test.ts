import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveModelCatalogArgs } from './modelCatalog';
import { sharedLaunchConfig } from '../shared/launch';

afterEach(() => vi.unstubAllEnvs());

describe('explicit Codex model catalog configuration', () => {
    it.each([undefined, '', '   '])('leaves native configuration intact when unset (%s)', value => {
        expect(resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_JSON: value })).toEqual([]);
    });
    it.each([
        ['linux', '/home/alice', '/catalogs/models with spaces.json', '/catalogs/models with spaces.json'],
        ['darwin', '/Users/alice', '~/Models/catalog.json', '/Users/alice/Models/catalog.json'],
        ['win32', 'C:\\Users\\Alice', 'D:\\Model Data\\catalog.json', 'D:\\Model Data\\catalog.json'],
        ['win32', 'C:\\Users\\Alice', '~\\Models\\catalog.json', 'C:\\Users\\Alice\\Models\\catalog.json'],
        ['win32', 'C:\\Users\\Alice', '\\\\server\\share\\catalog.json', '\\\\server\\share\\catalog.json']
    ] as const)('serializes a single TOML argument on %s', (platform, home, file, expected) => {
        expect(resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_JSON: file }, home, platform))
            .toEqual(['-c', `model_catalog_json=${JSON.stringify(expected)}`]);
    });
    it('passes through the path without reading or validating a catalog', () => {
        expect(resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_JSON: '/not-created/catalog.json' }, '/home/alice', 'linux'))
            .toEqual(['-c', 'model_catalog_json="/not-created/catalog.json"']);
    });
    it('rejects relative paths so runner and session working directories cannot change their meaning', () => {
        expect(() => resolveModelCatalogArgs([], { HAPI_CODEX_MODEL_CATALOG_JSON: 'catalog.json' })).toThrow('absolute path');
    });
    it.each(['-c', '--config'])('preserves an explicit %s launch override', flag => {
        expect(resolveModelCatalogArgs([flag, 'model_catalog_json="explicit.json"'], {
            HAPI_CODEX_MODEL_CATALOG_JSON: 'ignored-relative-path'
        })).toEqual([]);
    });
    it('does not treat another setting value as a catalog override', () => {
        expect(resolveModelCatalogArgs(['-c', 'model="model_catalog_json"'], {
            HAPI_CODEX_MODEL_CATALOG_JSON: '/catalog.json'
        }, '/home/alice', 'linux')).toHaveLength(2);
    });
    it('applies the setting to new and resumed shared launch configurations', () => {
        const file = process.platform === 'win32' ? 'C:\\Models\\catalog.json' : '/Models/catalog.json';
        vi.stubEnv('HAPI_CODEX_MODEL_CATALOG_JSON', file);
        for (const options of [{}, { resumeSessionId: 'existing-thread' }]) {
            const launch = sharedLaunchConfig(options, process.cwd());
            expect(launch.serverArgs).toContain(`model_catalog_json=${JSON.stringify(file)}`);
            expect(launch.tuiArgs).not.toContain(`model_catalog_json=${JSON.stringify(file)}`);
        }
    });
    it('normalizes and preserves an inline shared launch override', () => {
        vi.stubEnv('HAPI_CODEX_MODEL_CATALOG_JSON', '/ignored.json');
        const launch = sharedLaunchConfig({ codexArgs: ['--config=model_catalog_json="explicit.json"'] }, process.cwd());
        expect(launch.serverArgs).toEqual(['--config', 'model_catalog_json="explicit.json"']);
    });
});
