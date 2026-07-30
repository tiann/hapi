import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKimiSessionTitleWatcher, type KimiSessionTitleWatcher } from './kimiSessionTitleWatcher';

describe('kimiSessionTitleWatcher', () => {
    let testDir: string;
    let statePath: string;
    let watcher: KimiSessionTitleWatcher | null = null;

    beforeEach(async () => {
        testDir = join(tmpdir(), `kimi-title-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        statePath = join(testDir, 'state.json');
        await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
        if (watcher) {
            await watcher.cleanup();
            watcher = null;
        }
        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('emits an existing resume title immediately and later title changes once', async () => {
        await writeFile(statePath, JSON.stringify({ title: 'Existing title' }));
        const titles: string[] = [];

        watcher = await createKimiSessionTitleWatcher({
            statePath,
            intervalMs: 20,
            onTitle: (title) => titles.push(title)
        });

        expect(titles).toEqual(['Existing title']);

        await writeFile(statePath, '{');
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(titles).toEqual(['Existing title']);

        await writeFile(statePath, JSON.stringify({ title: 'Renamed title' }));
        await vi.waitFor(() => expect(titles).toEqual(['Existing title', 'Renamed title']));

        await writeFile(statePath, JSON.stringify({ title: 'Renamed title', updatedAt: Date.now() }));
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(titles).toEqual(['Existing title', 'Renamed title']);
    });

    it('detects a title when a new session writes state later and stops after cleanup', async () => {
        const titles: string[] = [];
        watcher = await createKimiSessionTitleWatcher({
            statePath,
            intervalMs: 20,
            onTitle: (title) => titles.push(title)
        });

        await writeFile(statePath, JSON.stringify({ title: 'New Session' }));
        await vi.waitFor(() => expect(titles).toEqual(['New Session']));

        await writeFile(statePath, JSON.stringify({ title: 'First prompt title' }));
        await vi.waitFor(() => expect(titles).toEqual(['New Session', 'First prompt title']));

        await watcher.cleanup();
        watcher = null;
        await writeFile(statePath, JSON.stringify({ title: 'After cleanup' }));
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(titles).toEqual(['New Session', 'First prompt title']);
    });
});
