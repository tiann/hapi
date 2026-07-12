import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexTranscriptLocator, type CodexTranscriptLocator } from './codexTranscriptLocator';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('codexTranscriptLocator', () => {
    let codexHome: string;
    let sessionDirectory: string;
    let locator: CodexTranscriptLocator | null = null;
    const originalCodexHome = process.env.CODEX_HOME;

    beforeEach(async () => {
        codexHome = join(tmpdir(), `codex-transcript-locator-${Date.now()}-${Math.random()}`);
        const now = new Date();
        sessionDirectory = join(
            codexHome,
            'sessions',
            String(now.getUTCFullYear()),
            String(now.getUTCMonth() + 1).padStart(2, '0'),
            String(now.getUTCDate()).padStart(2, '0')
        );
        await mkdir(sessionDirectory, { recursive: true });
        process.env.CODEX_HOME = codexHome;
    });

    afterEach(async () => {
        await locator?.cleanup();
        locator = null;
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }
        await rm(codexHome, { recursive: true, force: true });
    });

    it('does not attach for session metadata alone', async () => {
        const located: string[] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            onLocated: (result) => located.push(result.transcriptPath)
        });
        await locator.ready;
        const transcriptPath = await createTranscript('thread-meta-only', '/tmp/project');

        await wait(150);
        expect(located).toEqual([]);
        expect(transcriptPath).toContain('thread-meta-only');
    });

    it('attaches after fresh real user activity in the matching cwd', async () => {
        const located: string[] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            settlementMs: 25,
            onLocated: (result) => located.push(result.transcriptPath)
        });
        await locator.ready;
        const transcriptPath = await createTranscript('thread-user', '/tmp/project');

        await appendFile(transcriptPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello' }
        })}\n`);
        await wait(150);

        expect(located).toEqual([transcriptPath]);
    });

    it('attaches after image-only user activity', async () => {
        const located: string[] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            settlementMs: 0,
            onLocated: (result) => located.push(result.transcriptPath)
        });
        await locator.ready;
        const transcriptPath = await createTranscript('thread-image', '/tmp/project');

        await appendFile(transcriptPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: {
                type: 'user_message',
                message: '',
                images: ['data:image/png;base64,abc']
            }
        })}\n`);
        await wait(100);

        expect(located).toEqual([transcriptPath]);
    });

    it('refuses fallback when fresh activity is ambiguous', async () => {
        const located: string[] = [];
        const ambiguous: string[][] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            settlementMs: 50,
            onLocated: (result) => located.push(result.transcriptPath),
            onAmbiguous: (paths) => ambiguous.push(paths)
        });
        await locator.ready;
        const first = await createTranscript('thread-a', '/tmp/project');
        const second = await createTranscript('thread-b', '/tmp/project');

        const userEvent = `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'hello' }
        })}\n`;
        await Promise.all([appendFile(first, userEvent), appendFile(second, userEvent)]);
        await wait(150);

        expect(located).toEqual([]);
        expect(ambiguous).toHaveLength(1);
        expect(new Set(ambiguous[0])).toEqual(new Set([first, second]));
    });

    it('rejects candidates whose activity arrives in adjacent polling cycles', async () => {
        const located: string[] = [];
        const ambiguous: string[][] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            settlementMs: 150,
            onLocated: (result) => located.push(result.transcriptPath),
            onAmbiguous: (paths) => ambiguous.push(paths)
        });
        await locator.ready;
        const first = await createTranscript('thread-staggered-a', '/tmp/project');
        const second = await createTranscript('thread-staggered-b', '/tmp/project');
        const userEvent = (message: string) => JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message }
        });

        await appendFile(first, `${userEvent('first')}\n`);
        await wait(60);
        await appendFile(second, `${userEvent('second')}\n`);
        await wait(150);

        expect(located).toEqual([]);
        expect(ambiguous).toHaveLength(1);
        expect(new Set(ambiguous[0])).toEqual(new Set([first, second]));
    });

    it('retries an unterminated final JSON record after it is completed', async () => {
        const located: string[] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            settlementMs: 0,
            onLocated: (result) => located.push(result.transcriptPath)
        });
        await locator.ready;
        const transcriptPath = await createTranscript('thread-partial', '/tmp/project');
        const userEvent = JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'completed later' }
        });
        const splitAt = Math.floor(userEvent.length / 2);

        await appendFile(transcriptPath, userEvent.slice(0, splitAt));
        await wait(75);
        expect(located).toEqual([]);

        await appendFile(transcriptPath, userEvent.slice(splitAt));
        await wait(100);
        expect(located).toEqual([transcriptPath]);
    });

    it('ignores pre-existing fresh transcripts even when they receive new activity', async () => {
        const transcriptPath = await createTranscript('thread-existing', '/tmp/project');
        const located: string[] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/project',
            startupTimestampMs: Date.now(),
            intervalMs: 25,
            settlementMs: 0,
            onLocated: (result) => located.push(result.transcriptPath)
        });
        await locator.ready;

        await appendFile(transcriptPath, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'other terminal' }
        })}\n`);
        await wait(100);

        expect(located).toEqual([]);
    });

    it('polls only the exact resume transcript once it is found', async () => {
        const unrelated = await createTranscript('thread-unrelated', '/tmp/project');
        const target = await createTranscript('thread-resume', '/tmp/original-project');
        await appendFile(unrelated, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'unrelated activity' }
        })}\n`);
        const located: string[] = [];
        const ambiguous: string[][] = [];
        locator = createCodexTranscriptLocator({
            cwd: '/tmp/current-project',
            startupTimestampMs: Date.now(),
            resumeSessionId: 'thread-resume',
            intervalMs: 25,
            onLocated: (result) => located.push(result.transcriptPath),
            onAmbiguous: (paths) => ambiguous.push(paths)
        });
        await locator.ready;

        await appendFile(target, `${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'resume activity' }
        })}\n`);
        await wait(100);

        expect(located).toEqual([target]);
        expect(ambiguous).toEqual([]);
    });

    async function createTranscript(sessionId: string, cwd: string): Promise<string> {
        const transcriptPath = join(sessionDirectory, `rollout-${sessionId}.jsonl`);
        await writeFile(transcriptPath, `${JSON.stringify({
            type: 'session_meta',
            payload: { id: sessionId, cwd }
        })}\n`);
        return transcriptPath;
    }
});
