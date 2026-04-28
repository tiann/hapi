import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexSessionScanner } from './codexSessionScanner';
import type { CodexSessionEvent } from './codexEventConverter';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('codexSessionScanner', () => {
    let testDir: string;
    let transcriptPath: string;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
    let events: CodexSessionEvent[] = [];

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-scanner-${Date.now()}`);
        await mkdir(testDir, { recursive: true });
        transcriptPath = join(testDir, 'codex-session.jsonl');
        events = [];
    });

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }

        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('emits only new events after startup', async () => {
        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'session-123' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old' } })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            transcriptPath,
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(0);

        await appendFile(
            transcriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'new' } }) + '\n'
        );

        await wait(700);
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe('event_msg');
    });

    it('can replay existing events on startup', async () => {
        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'session-123' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'old prompt' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old answer' } })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            transcriptPath,
            replayExistingEvents: true,
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events.map((event) => event.payload)).toEqual([
            { id: 'session-123' },
            { type: 'user_message', message: 'old prompt' },
            { type: 'agent_message', message: 'old answer' }
        ]);
    });

    it('reports session id from the transcript metadata', async () => {
        await writeFile(
            transcriptPath,
            JSON.stringify({ type: 'session_meta', payload: { id: 'session-xyz' } }) + '\n'
        );

        let observedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            transcriptPath,
            onEvent: (event) => events.push(event),
            onSessionId: (sessionId) => {
                observedSessionId = sessionId;
            }
        });

        expect(observedSessionId).toBe('session-xyz');
        expect(events).toHaveLength(0);
    });

    it('switches to a newly supplied transcript path without replaying history', async () => {
        const firstTranscriptPath = join(testDir, 'first.jsonl');
        const secondTranscriptPath = join(testDir, 'second.jsonl');

        await writeFile(
            firstTranscriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'first-old' } }) + '\n'
        );
        await writeFile(
            secondTranscriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'second-old' } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            transcriptPath: firstTranscriptPath,
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(0);

        await appendFile(
            firstTranscriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'first-new' } }) + '\n'
        );
        await wait(700);
        expect(events).toHaveLength(1);

        await scanner.setTranscriptPath(secondTranscriptPath);
        await wait(300);
        expect(events).toHaveLength(1);

        await appendFile(
            secondTranscriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'second-new' } }) + '\n'
        );
        await wait(700);
        expect(events).toHaveLength(2);
        expect(events[1]?.payload).toEqual({ type: 'agent_message', message: 'second-new' });
    });

    it('resets line cursor when the transcript file is truncated', async () => {
        await writeFile(
            transcriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'before-truncate' } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            transcriptPath,
            onEvent: (event) => events.push(event)
        });

        await wait(300);
        expect(events).toHaveLength(0);

        await writeFile(
            transcriptPath,
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'after-truncate' } }) + '\n'
        );

        await wait(700);
        expect(events).toHaveLength(1);
        expect(events[0]?.payload).toEqual({ type: 'agent_message', message: 'after-truncate' });
    });
});
