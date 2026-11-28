import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    createKimiWireLocator,
    encodeKimiWorkDirKey,
    getKimiStatePath,
    getKimiWirePath,
    type LocatedKimiWire
} from './kimiWireLocator';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('encodeKimiWorkDirKey', () => {
    it('matches the kimi-code workspace id scheme', () => {
        // wd_<slug>_<sha256(normalizedWorkDir).slice(0,12)>
        expect(encodeKimiWorkDirKey('/Users/weishu/dev/github/hapi')).toBe('wd_hapi_dd2c162dd303');
        expect(encodeKimiWorkDirKey('/tmp')).toMatch(/^wd_tmp_[0-9a-f]{12}$/);
        expect(encodeKimiWorkDirKey('/home/user/My Project!')).toMatch(/^wd_my-project_[0-9a-f]{12}$/);
    });
});

describe('kimiWireLocator', () => {
    let homeDir: string;
    let workDir: string;
    let previousHome: string | undefined;

    beforeEach(async () => {
        previousHome = process.env.KIMI_CODE_HOME;
        homeDir = join(tmpdir(), `kimi-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        workDir = join(tmpdir(), `kimi-wd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(homeDir, { recursive: true });
        await mkdir(workDir, { recursive: true });
        process.env.KIMI_CODE_HOME = homeDir;
    });

    afterEach(async () => {
        if (previousHome === undefined) {
            delete process.env.KIMI_CODE_HOME;
        } else {
            process.env.KIMI_CODE_HOME = previousHome;
        }
        for (const dir of [homeDir, workDir]) {
            if (existsSync(dir)) {
                await rm(dir, { recursive: true, force: true });
            }
        }
    });

    async function seedSession(sessionId: string): Promise<string> {
        const sessionDir = join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), sessionId);
        await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
        await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ workDir }));
        await writeFile(getKimiWirePath(sessionDir), JSON.stringify({ type: 'metadata', protocol_version: '1.4', created_at: Date.now() }) + '\n');
        return sessionDir;
    }

    it('locates a freshly created session and resolves its wire path', async () => {
        const located: LocatedKimiWire[] = [];
        const locator = createKimiWireLocator({
            cwd: workDir,
            startupTimestampMs: Date.now(),
            intervalMs: 50,
            onLocated: (result) => located.push(result)
        });

        try {
            // Session dir appears slightly after hapi's launch timestamp.
            await wait(100);
            await seedSession('session_aaa-bbb');

            await wait(400);
            expect(located).toHaveLength(1);
            expect(located[0]?.sessionId).toBe('session_aaa-bbb');
            expect(located[0]?.wirePath).toBe(getKimiWirePath(join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), 'session_aaa-bbb')));
            expect(located[0]?.statePath).toBe(getKimiStatePath(join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), 'session_aaa-bbb')));
        } finally {
            await locator.cleanup();
        }
    });

    it('targets the resumed session id directly, ignoring creation time', async () => {
        await seedSession('session_old-resume');

        const located: LocatedKimiWire[] = [];
        const locator = createKimiWireLocator({
            cwd: workDir,
            startupTimestampMs: Date.now() + 60_000, // dir is "older" than launch
            resumeSessionId: 'session_old-resume',
            intervalMs: 50,
            onLocated: (result) => located.push(result)
        });

        try {
            await wait(300);
            expect(located).toHaveLength(0);

            // The TUI writes to the journal when it actually opens the session.
            const sessionDir = join(homeDir, 'sessions', encodeKimiWorkDirKey(workDir), 'session_old-resume');
            const wirePath = getKimiWirePath(sessionDir);
            const baselineStats = await stat(wirePath);
            await writeFile(wirePath, JSON.stringify({ type: 'turn.prompt', time: Date.now() }) + '\n', { flag: 'a' });
            await wait(300);
            expect(located).toHaveLength(1);
            expect(located[0]?.sessionId).toBe('session_old-resume');
            expect(located[0]?.wireBaseline).toEqual({
                device: baselineStats.dev,
                inode: baselineStats.ino,
                offset: baselineStats.size
            });
        } finally {
            await locator.cleanup();
        }
    });

    it('scans once at cleanup so a resume confirmed after the last poll is still located', async () => {
        const sessionDir = await seedSession('session_late-resume');
        const wirePath = getKimiWirePath(sessionDir);
        const baselineStats = await stat(wirePath);

        const located: LocatedKimiWire[] = [];
        const locator = createKimiWireLocator({
            cwd: workDir,
            startupTimestampMs: Date.now(),
            resumeSessionId: 'session_late-resume',
            intervalMs: 60_000,
            onLocated: (result) => located.push(result)
        });

        await locator.ready;
        await wait(50);
        expect(located).toHaveLength(0);

        await writeFile(wirePath, JSON.stringify({ type: 'turn.prompt', time: Date.now() }) + '\n', { flag: 'a' });
        await locator.cleanup();

        expect(located).toHaveLength(1);
        expect(located[0]).toMatchObject({
            sessionId: 'session_late-resume',
            wireBaseline: {
                device: baselineStats.dev,
                inode: baselineStats.ino,
                offset: baselineStats.size
            }
        });
    });

    it('detects a resumed journal replaced with the same size and mtime', async () => {
        const sessionDir = await seedSession('session_replaced-resume');
        const wirePath = getKimiWirePath(sessionDir);
        // A whole-second mtime round-trips exactly through utimes on every filesystem.
        const fixedTime = Math.floor(Date.now() / 1000);
        await utimes(wirePath, fixedTime, fixedTime);
        const baselineStats = await stat(wirePath);

        const located: LocatedKimiWire[] = [];
        const locator = createKimiWireLocator({
            cwd: workDir,
            startupTimestampMs: Date.now(),
            resumeSessionId: 'session_replaced-resume',
            intervalMs: 60_000,
            onLocated: (result) => located.push(result)
        });

        await locator.ready;
        await wait(50);
        expect(located).toHaveLength(0);

        // Replace the file with a different inode holding the same bytes and
        // the same mtime, so only the file identity reveals the replacement.
        const replacementPath = join(sessionDir, 'agents', 'main', 'wire-replacement.jsonl');
        await writeFile(replacementPath, await readFile(wirePath));
        await utimes(replacementPath, fixedTime, fixedTime);
        await rename(replacementPath, wirePath);

        const replacedStats = await stat(wirePath);
        expect(replacedStats.size).toBe(baselineStats.size);
        expect(replacedStats.mtimeMs).toBe(baselineStats.mtimeMs);
        expect(replacedStats.ino).not.toBe(baselineStats.ino);

        // The final poll must notice the replacement, even though the TUI
        // wrote nothing new before exiting.
        await locator.cleanup();

        expect(located).toHaveLength(1);
        expect(located[0]?.sessionId).toBe('session_replaced-resume');
    });

    it('excludes sessions that already existed when the locator started (retry race)', async () => {
        // Simulate an immediate `hapi kimi` retry: the previous launch's
        // session dir already exists and is within the birth-time grace
        // window, but it must not be adopted — the new process has not
        // created its session yet.
        await seedSession('session_previous-launch');

        const located: LocatedKimiWire[] = [];
        const locator = createKimiWireLocator({
            cwd: workDir,
            startupTimestampMs: Date.now() - 1000, // dir birth time is inside the grace window
            intervalMs: 50,
            onLocated: (result) => located.push(result)
        });

        try {
            await wait(300);
            expect(located).toHaveLength(0);

            // The session created by the new process is still picked up.
            await seedSession('session_new-launch');
            await wait(300);
            expect(located).toHaveLength(1);
            expect(located[0]?.sessionId).toBe('session_new-launch');
        } finally {
            await locator.cleanup();
        }
    });

    it('refuses to attach when multiple fresh sessions appear', async () => {
        const ambiguous: string[][] = [];
        const located: LocatedKimiWire[] = [];
        const locator = createKimiWireLocator({
            cwd: workDir,
            startupTimestampMs: Date.now(),
            intervalMs: 50,
            onLocated: (result) => located.push(result),
            onAmbiguous: (ids) => ambiguous.push(ids)
        });

        try {
            await seedSession('session_one');
            await seedSession('session_two');
            await wait(300);

            expect(located).toHaveLength(0);
            expect(ambiguous).toHaveLength(1);
            expect(ambiguous[0]?.sort()).toEqual(['session_one', 'session_two']);
        } finally {
            await locator.cleanup();
        }
    });
});
