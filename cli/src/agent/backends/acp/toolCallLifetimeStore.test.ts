import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileToolCallLifetimeStore, defaultToolCallLifetimeStore } from './toolCallLifetimeStore';

const dirs: string[] = [];
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-lifetimes-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('tool call lifetime store', () => {
    it('round-trips the open lifetimes of an ACP session and removes the file once none are open', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir, 'hapi-session-1');
        const lifetimes = [{ agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#a' }];
        store.save('ses_1', lifetimes);

        expect(createFileToolCallLifetimeStore(dir, 'hapi-session-1').load('ses_1')).toEqual(lifetimes);
        expect(store.load('ses_2')).toEqual([]);
        expect(createFileToolCallLifetimeStore(dir, 'hapi-session-2').load('ses_1')).toEqual([]);

        store.save('ses_1', []);
        expect(readdirSync(dir)).toEqual([]);
    });

    it('ignores a damaged file', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir);
        store.save('ses_1', [{ agentToolCallId: 'a', scope: 'main', id: 'a#1' }]);
        const [file] = readdirSync(dir);
        writeFileSync(join(dir, file), '{"lifetimes":[{"id":1}]');
        expect(store.load('ses_1')).toEqual([]);
    });

    it('persists only for a process that serves a HAPI session', () => {
        expect(defaultToolCallLifetimeStore({})).toBeNull();
        expect(defaultToolCallLifetimeStore({ HAPI_SESSION_ID: 'abc', HAPI_HOME: tempDir() })).not.toBeNull();
    });

    it('never removes another session\'s file, however old', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir, 'idle-but-live');
        store.save('ses_old', [{ agentToolCallId: 'a', scope: 'main', id: 'a#1' }]);
        const [oldFile] = readdirSync(dir);
        const longAgo = new Date(Date.now() - 30 * 24 * 3600_000);
        utimesSync(join(dir, oldFile), longAgo, longAgo);

        createFileToolCallLifetimeStore(dir, 'other').save('ses_new', [{ agentToolCallId: 'b', scope: 'main', id: 'b#1' }]);

        expect(createFileToolCallLifetimeStore(dir, 'idle-but-live').load('ses_old')).toEqual([{ agentToolCallId: 'a', scope: 'main', id: 'a#1' }]);
    });

    it('replays journaled opens on top of the snapshot and compacts them on save', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir, 'hapi');
        store.save('ses_1', [{ agentToolCallId: 'a', scope: 'main', id: 'a#1' }]);
        store.append('ses_1', { agentToolCallId: 'b', scope: 'main', id: 'b#1' });
        store.append('ses_1', { agentToolCallId: 'c', scope: 'main', id: 'c#1' });
        expect(createFileToolCallLifetimeStore(dir, 'hapi').load('ses_1').map((entry) => entry.id)).toEqual(['a#1', 'b#1', 'c#1']);

        store.save('ses_1', [{ agentToolCallId: 'c', scope: 'main', id: 'c#1' }]);
        expect(readdirSync(dir)).toHaveLength(1);
        expect(store.load('ses_1').map((entry) => entry.id)).toEqual(['c#1']);

        store.save('ses_1', []);
        expect(readdirSync(dir)).toEqual([]);
    });

    it('skips a torn last journal line', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir);
        store.append('ses_1', { agentToolCallId: 'a', scope: 'main', id: 'a#1' });
        const [journal] = readdirSync(dir);
        writeFileSync(join(dir, journal), '\n{"agentToolCallId":"b","sco', { flag: 'a' });
        expect(store.load('ses_1').map((entry) => entry.id)).toEqual(['a#1']);
    });

    it('replays the journal last-wins and never restores a call closed since the snapshot', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir);
        store.append('ses_1', { agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#A' });
        store.appendClose('ses_1', 'shell:0#A');
        store.append('ses_1', { agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#B' });
        store.append('ses_1', { agentToolCallId: 'read:0', scope: 'main', id: 'read:0#A' });
        store.append('ses_1', { agentToolCallId: 'read:0', scope: 'main', id: 'read:0#B' });
        expect(store.load('ses_1').map((entry) => entry.id)).toEqual(['shell:0#B', 'read:0#B']);
    });

    it('keeps the next record after a torn last line', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir);
        store.append('ses_1', { agentToolCallId: 'a', scope: 'main', id: 'a#1' });
        const [journal] = readdirSync(dir);
        // A crash mid-append leaves a prefix of `\n{...}`: the record's own leading newline.
        writeFileSync(join(dir, journal), '\n{"agentToolCallId":"torn:0","sco', { flag: 'a' });
        store.append('ses_1', { agentToolCallId: 'b', scope: 'main', id: 'b#1' });
        expect(store.load('ses_1').map((entry) => entry.id)).toEqual(['a#1', 'b#1']);
    });

    it("removes the session's own orphaned temporary files on load", () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir, 'hapi');
        store.save('ses_1', [{ agentToolCallId: 'a', scope: 'main', id: 'a#1' }]);
        const [snapshot] = readdirSync(dir);
        const orphan = snapshot.replace(/\.json$/, '.3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b.tmp');
        const foreign = 'f'.repeat(40) + '.3f0e8b9a-1d2c-4e5f-8a9b-0c1d2e3f4a5b.tmp';
        writeFileSync(join(dir, orphan), '{');
        writeFileSync(join(dir, foreign), '{');
        store.load('ses_1');
        expect(readdirSync(dir).sort()).toEqual([foreign, snapshot].sort());
    });

    it('creates the directory and files readable by the owner only', () => {
        const dir = join(tempDir(), 'records');
        const store = createFileToolCallLifetimeStore(dir);
        store.append('ses_1', { agentToolCallId: 'a', scope: 'main', id: 'a#1' });
        store.save('ses_2', [{ agentToolCallId: 'b', scope: 'main', id: 'b#1' }]);
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        for (const name of readdirSync(dir)) {
            expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
        }
    });

    it('restores a newer reuse journaled after an older snapshot entry', () => {
        const dir = tempDir();
        const store = createFileToolCallLifetimeStore(dir);
        store.save('ses_1', [{ agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#A' }]);
        store.append('ses_1', { agentToolCallId: 'shell:0', scope: 'main', id: 'shell:0#B' });
        expect(store.load('ses_1').map((entry) => entry.id)).toEqual(['shell:0#B']);
    });

    it.skipIf(process.platform === 'win32')('tightens a record directory and files left with wider modes by an older build', () => {
        const dir = join(tempDir(), 'records');
        const older = createFileToolCallLifetimeStore(dir);
        older.append('ses_1', { agentToolCallId: 'a', scope: 'main', id: 'a#1' });
        older.save('ses_2', [{ agentToolCallId: 'b', scope: 'main', id: 'b#1' }]);
        chmodSync(dir, 0o755);
        for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o644);

        const store = createFileToolCallLifetimeStore(dir);
        store.load('ses_1');
        store.append('ses_2', { agentToolCallId: 'c', scope: 'main', id: 'c#1' });

        expect(statSync(dir).mode & 0o777).toBe(0o700);
        for (const name of readdirSync(dir)) {
            expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
        }
    });
});
