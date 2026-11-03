import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { constructorOptions, listModelsMock } = vi.hoisted(() => ({
    constructorOptions: [] as unknown[],
    listModelsMock: vi.fn()
}));

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, homedir: vi.fn(() => '/neutral-home') };
});

vi.mock('@/codex/codexAppServerClient', () => ({
    CodexAppServerClient: class {
        constructor(options: unknown) {
            constructorOptions.push(options);
        }

        async connect(): Promise<void> {}
        async initialize(): Promise<void> {}
        async listModels(): Promise<{ data: unknown[] }> {
            return listModelsMock();
        }
        async disconnect(): Promise<void> {}
    }
}));

import { listCodexModels, _resetCodexModelsCacheForTests } from './codexModels';

describe('listCodexModels cwd', () => {
    const temporaryHomes: string[] = [];
    beforeEach(() => {
        constructorOptions.length = 0;
        listModelsMock.mockReset();
        _resetCodexModelsCacheForTests();
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(temporaryHomes.splice(0).map(home => rm(home, { recursive: true, force: true })));
    });

    it('starts discovery from the user home instead of the caller cwd', async () => {
        listModelsMock.mockResolvedValue({ data: [] });

        await listCodexModels();

        expect(constructorOptions).toEqual([{ cwd: '/neutral-home' }]);
    });

    it('caches the model list within the TTL so repeat calls skip the app-server spawn', async () => {
        listModelsMock.mockResolvedValue({
            data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }]
        });

        const first = await listCodexModels();
        const second = await listCodexModels();

        expect(first).toEqual([expect.objectContaining({
            id: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            isDefault: true
        })]);
        expect(second).toEqual(first);
        expect(constructorOptions).toHaveLength(1);
        expect(listModelsMock).toHaveBeenCalledTimes(1);
    });

    it('keeps visible and hidden model lists in separate cache slots', async () => {
        listModelsMock.mockResolvedValue({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

        await listCodexModels(false);
        await listCodexModels(false);
        await listCodexModels(true);
        await listCodexModels(true);

        expect(constructorOptions).toHaveLength(2);
    });

    it('coalesces concurrent requests into a single app-server spawn', async () => {
        let resolveList: (value: { data: unknown[] }) => void = () => undefined;
        listModelsMock.mockImplementationOnce(
            () => new Promise((res) => { resolveList = res; })
        );

        const inflight1 = listCodexModels();
        const inflight2 = listCodexModels();

        await vi.waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(1));
        resolveList({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

        const [first, second] = await Promise.all([inflight1, inflight2]);

        expect(constructorOptions).toHaveLength(1);
        expect(listModelsMock).toHaveBeenCalledTimes(1);
        expect(first).toEqual(second);
        expect(first).toHaveLength(1);
    });

    it('expires the cache after the TTL so a later call respawns the app-server', async () => {
        vi.useFakeTimers();
        try {
            listModelsMock.mockResolvedValue({ data: [{ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' }] });

            await listCodexModels();
            expect(constructorOptions).toHaveLength(1);

            vi.advanceTimersByTime(5 * 60_000 + 1);
            await listCodexModels();
            expect(constructorOptions).toHaveLength(1);

            vi.advanceTimersByTime(24 * 60 * 60_000);
            await listCodexModels();
            expect(constructorOptions).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('invalidates successful discovery when the local catalog or auth changes', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-codex-models-'));
        temporaryHomes.push(home);
        vi.stubEnv('CODEX_HOME', home);
        const catalog = join(home, 'models.json');
        await writeFile(join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(catalog)}\n`);
        await writeFile(catalog, '{"models":["first"]}');
        listModelsMock.mockResolvedValue({ data: [{ id: 'first' }] });

        await listCodexModels();
        await listCodexModels();
        expect(constructorOptions).toHaveLength(1);

        await writeFile(catalog, '{"models":["second"]}');
        listModelsMock.mockResolvedValue({ data: [{ id: 'second' }] });
        expect((await listCodexModels())[0]?.id).toBe('second');
        expect(constructorOptions).toHaveLength(2);

        await writeFile(join(home, 'auth.json'), '{"auth":"changed"}');
        await listCodexModels();
        expect(constructorOptions).toHaveLength(3);

        await writeFile(join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(catalog)}\nmodel = "second"\n`);
        await listCodexModels();
        expect(constructorOptions).toHaveLength(4);
    });

    it('resolves a relative catalog path from the Codex config directory', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-codex-models-'));
        temporaryHomes.push(home);
        vi.stubEnv('CODEX_HOME', home);
        await writeFile(join(home, 'config.toml'), 'model_catalog_json = "models.json"\n');
        const catalog = join(home, 'models.json');
        await writeFile(catalog, 'first');
        listModelsMock.mockResolvedValue({ data: [{ id: 'first' }] });
        await listCodexModels();

        await writeFile(catalog, 'second');
        listModelsMock.mockResolvedValue({ data: [{ id: 'second' }] });
        expect((await listCodexModels())[0]?.id).toBe('second');
        expect(constructorOptions).toHaveLength(2);
    });

    it('does not let an older in-flight lookup replace a newer catalog', async () => {
        const home = await mkdtemp(join(tmpdir(), 'hapi-codex-models-'));
        temporaryHomes.push(home);
        vi.stubEnv('CODEX_HOME', home);
        const catalog = join(home, 'models.json');
        await writeFile(join(home, 'config.toml'), `model_catalog_json = ${JSON.stringify(catalog)}\n`);
        await writeFile(catalog, 'first');
        let resolveFirst: (value: { data: unknown[] }) => void = () => undefined;
        listModelsMock.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
        const first = listCodexModels();
        await vi.waitFor(() => expect(listModelsMock).toHaveBeenCalledTimes(1));

        await writeFile(catalog, 'second');
        listModelsMock.mockResolvedValue({ data: [{ id: 'second' }] });
        await listCodexModels();
        resolveFirst({ data: [{ id: 'first' }] });
        await first;

        expect((await listCodexModels())[0]?.id).toBe('second');
        expect(constructorOptions).toHaveLength(2);
    });

    it('does not cache empty or failed results', async () => {
        listModelsMock.mockResolvedValue({ data: [] });
        await listCodexModels();
        await listCodexModels();
        expect(constructorOptions).toHaveLength(2);

        listModelsMock.mockRejectedValue(new Error('app-server exploded'));
        await expect(listCodexModels()).rejects.toThrow('app-server exploded');
        await expect(listCodexModels()).rejects.toThrow('app-server exploded');
        expect(constructorOptions).toHaveLength(4);
    });
});
