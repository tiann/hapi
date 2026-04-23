import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCodexSessionFile } from './resolveCodexSessionFile';

describe('resolveCodexSessionFile', () => {
    let testDir: string;
    let sessionsDir: string;
    let originalCodexHome: string | undefined;

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-session-resolver-${Date.now()}`);
        sessionsDir = join(testDir, 'sessions', '2026', '04', '02');
        await mkdir(sessionsDir, { recursive: true });

        originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = testDir;
    });

    afterEach(async () => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }

        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('finds a unique matching transcript file', async () => {
        const sessionId = 'session-unique';
        const filePath = join(sessionsDir, `codex-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            [
                JSON.stringify({
                    type: 'session_meta',
                    payload: { id: sessionId, cwd: '/work/unique', timestamp: '2026-04-02T01:02:03.000Z' }
                }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
            ].join('\n') + '\n'
        );

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'found',
            filePath,
            cwd: '/work/unique',
            timestamp: Date.parse('2026-04-02T01:02:03.000Z')
        });
    });

    it('succeeds when session_meta is missing cwd', async () => {
        const sessionId = 'session-missing-cwd';
        const filePath = join(sessionsDir, `codex-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: sessionId, timestamp: '2026-04-02T01:02:03.000Z' }
            }) + '\n'
        );

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'found',
            filePath,
            cwd: null,
            timestamp: Date.parse('2026-04-02T01:02:03.000Z')
        });
    });

    it('succeeds when session_meta is missing timestamp', async () => {
        const sessionId = 'session-missing-timestamp';
        const filePath = join(sessionsDir, `codex-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: sessionId, cwd: '/work/missing-timestamp' }
            }) + '\n'
        );

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'found',
            filePath,
            cwd: '/work/missing-timestamp',
            timestamp: null
        });
    });

    it('returns not_found when no transcript matches', async () => {
        const result = await resolveCodexSessionFile('session-missing');

        expect(result).toEqual({
            status: 'not_found'
        });
    });

    it('returns ambiguous when multiple files match the same session id suffix', async () => {
        const sessionId = 'session-ambiguous';
        const firstFile = join(sessionsDir, `codex-${sessionId}.jsonl`);
        const secondDir = join(testDir, 'sessions', '2026', '04', '01');
        await mkdir(secondDir, { recursive: true });
        const secondFile = join(secondDir, `codex-${sessionId}.jsonl`);

        const meta = JSON.stringify({
            type: 'session_meta',
            payload: { id: sessionId, cwd: '/work/ambiguous', timestamp: '2026-04-02T01:02:03.000Z' }
        });
        await writeFile(firstFile, meta + '\n');
        await writeFile(secondFile, meta + '\n');

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'ambiguous',
            filePaths: [secondFile, firstFile]
        });
    });

    it('returns invalid for an invalid first line', async () => {
        const sessionId = 'session-invalid-first-line';
        const filePath = join(sessionsDir, `codex-${sessionId}.jsonl`);
        await writeFile(filePath, JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }) + '\n');

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'invalid',
            filePath,
            reason: 'invalid_session_meta'
        });
    });

    it('returns invalid when the first line is session_meta but fields are invalid', async () => {
        const sessionId = 'session-invalid-meta';
        const filePath = join(sessionsDir, `codex-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            JSON.stringify({
                type: 'session_meta',
                payload: { cwd: '/work/invalid-meta', timestamp: '2026-04-02T01:02:03.000Z' }
            }) + '\n'
        );

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'invalid',
            filePath,
            reason: 'invalid_session_meta'
        });
    });

    it('returns invalid when session_meta payload id mismatches the requested session id', async () => {
        const sessionId = 'session-requested';
        const filePath = join(sessionsDir, `codex-${sessionId}.jsonl`);
        await writeFile(
            filePath,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: 'session-other', cwd: '/work/mismatch', timestamp: '2026-04-02T01:02:03.000Z' }
            }) + '\n'
        );

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'invalid',
            filePath,
            reason: 'session_id_mismatch'
        });
    });

    it('resolves to the valid transcript when a corrupt duplicate suffix also exists', async () => {
        const sessionId = 'session-mixed';
        const validFile = join(sessionsDir, `codex-${sessionId}.jsonl`);
        const invalidDir = join(testDir, 'sessions', '2026', '04', '01');
        await mkdir(invalidDir, { recursive: true });
        const invalidFile = join(invalidDir, `codex-${sessionId}.jsonl`);

        await writeFile(
            validFile,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: sessionId, cwd: '/work/mixed', timestamp: '2026-04-02T01:02:03.000Z' }
            }) + '\n'
        );
        await writeFile(
            invalidFile,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: 'session-other', cwd: '/work/corrupt', timestamp: '2026-04-02T01:02:03.000Z' }
            }) + '\n'
        );

        const result = await resolveCodexSessionFile(sessionId);

        expect(result).toEqual({
            status: 'found',
            filePath: validFile,
            cwd: '/work/mixed',
            timestamp: Date.parse('2026-04-02T01:02:03.000Z')
        });
    });
});
