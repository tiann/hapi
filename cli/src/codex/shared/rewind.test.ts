import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedRewindBarrier, isNativeHistoryRead } from './rewind';

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'hapi-rewind-')); homes.push(home);
    const file = join(home, 'barrier.json');
    return { file, barrier: new SharedRewindBarrier(file) };
}
describe('shared rewind admission', () => {
    it('excludes in-flight writes and prevents new writes until commit', async () => {
        const { barrier } = await fixture();
        const release = barrier.enter();
        await expect(barrier.begin()).rejects.toThrow('in flight');
        release(); release();
        const token = await barrier.begin();
        expect(() => barrier.enter()).toThrow('rewind');
        await expect(barrier.begin()).rejects.toThrow('rewind');
        await barrier.complete(token, async () => {});
        barrier.enter()();
        await barrier.complete(token, async () => { throw new Error('Must not repeat'); });
    });
    it('retains quarantine across failed commit and process replacement', async () => {
        const { file, barrier } = await fixture();
        const token = await barrier.begin();
        await expect(barrier.complete(token, async () => { throw new Error('Hub lost'); })).rejects.toThrow('Hub lost');
        expect(() => barrier.enter()).toThrow();
        const replacement = new SharedRewindBarrier(file); await replacement.load();
        expect(() => replacement.enter()).toThrow();
        await expect(replacement.complete(token, async () => {})).rejects.toThrow('Invalid');
    });
    it('unlocks only a proven rejection before native dispatch', async () => {
        const { file, barrier } = await fixture();
        await barrier.begin(); await barrier.cancel();
        const replacement = new SharedRewindBarrier(file); await replacement.load();
        replacement.enter()();
    });
    it('treats new native methods as mutations by default', () => {
        expect(isNativeHistoryRead('thread/turns/list')).toBe(true);
        for (const method of ['turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start',
            'thread/settings/update', 'thread/compact/start', 'thread/fork', 'thread/revert', 'future/write']) {
            expect(isNativeHistoryRead(method)).toBe(false);
        }
    });
});
