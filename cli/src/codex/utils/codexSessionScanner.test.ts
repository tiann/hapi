import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createCodexSessionScanner } from './codexSessionScanner';
import type { CodexSessionEvent } from './codexEventConverter';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('codexSessionScanner', () => {
    let testDir: string;
    let sessionsDir: string;
    let sessionFile: string;
    let originalCodexHome: string | undefined;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
    let events: CodexSessionEvent[] = [];

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-scanner-${Date.now()}`);
        sessionsDir = join(testDir, 'sessions', '2025', '12', '22');
        await mkdir(sessionsDir, { recursive: true });

        originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = testDir;

        events = [];
    });

    afterEach(async () => {
        if (scanner) {
            await scanner.cleanup();
            scanner = null;
        }

        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }

        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('emits only new events after startup', async () => {
        const sessionId = 'session-123';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        const initialLines = [
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
        ];

        await writeFile(sessionFile, initialLines.join('\n') + '\n');

        scanner = await createCodexSessionScanner({
            sessionId,
            onEvent: (event) => events.push(event)
        });

        await wait(150);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-1', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('limits session scan to dates within the start window', async () => {
        const referenceTimestampMs = Date.parse('2025-12-22T00:00:00.000Z');
        const windowMs = 2 * 60 * 1000;
        const matchingSessionId = 'session-222';
        const outsideSessionId = 'session-999';
        const outsideDir = join(testDir, 'sessions', '2025', '12', '20');
        const matchingFile = join(sessionsDir, `codex-${matchingSessionId}.jsonl`);
        const outsideFile = join(outsideDir, `codex-${outsideSessionId}.jsonl`);

        await mkdir(outsideDir, { recursive: true });
        const baseLines = [
            JSON.stringify({ type: 'session_meta', payload: { id: matchingSessionId, cwd: '/data/github/happy/hapi', timestamp: '2025-12-22T00:00:30.000Z' } }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'hello' } })
        ];
        await writeFile(matchingFile, baseLines.join('\n') + '\n');
        await writeFile(
            outsideFile,
            JSON.stringify({ type: 'session_meta', payload: { id: outsideSessionId, cwd: '/data/github/happy/hapi', timestamp: '2025-12-20T00:00:00.000Z' } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: '/data/github/happy/hapi',
            startupTimestampMs: referenceTimestampMs,
            sessionStartWindowMs: windowMs,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-2', arguments: '{}' }
        });
        await appendFile(matchingFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('fails fast when cwd is missing and no sessionId is provided', async () => {
        const sessionId = 'session-missing-cwd';
        const matchFailedMessage = 'No cwd provided for Codex session matching; refusing to fallback.';
        sessionFile = join(sessionsDir, `codex-${sessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({ type: 'session_meta', payload: { id: sessionId } }) + '\n'
        );

        let failureMessage: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            onEvent: (event) => events.push(event),
            onSessionMatchFailed: (message) => {
                failureMessage = message;
            }
        });

        await wait(150);
        expect(failureMessage).toBe(matchFailedMessage);
        expect(events).toHaveLength(0);

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-3', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(200);
        expect(events).toHaveLength(0);
    });

    it('adopts a reused older session file when fresh matching activity appears after startup', async () => {
        const reusedSessionId = 'session-reused-old-file';
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const now = new Date(startupTimestampMs);
        const currentSessionsDir = join(
            testDir,
            'sessions',
            String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        );
        await mkdir(currentSessionsDir, { recursive: true });
        sessionFile = join(currentSessionsDir, `codex-${reusedSessionId}.jsonl`);

        await writeFile(
            sessionFile,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: reusedSessionId,
                    cwd: targetCwd,
                    timestamp: new Date(startupTimestampMs - 10 * 60 * 1000).toISOString()
                }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            }
        });

        await wait(150);
        expect(events).toHaveLength(0);
        expect(matchedSessionId).toBeNull();

        const newLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused', arguments: '{}' }
        });
        await appendFile(sessionFile, newLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBe(reusedSessionId);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('response_item');
    });

    it('does not adopt a reused session when first fresh matching activity is ambiguous', async () => {
        const targetCwd = '/data/github/happy/hapi';
        const startupTimestampMs = Date.now();
        const now = new Date(startupTimestampMs);
        const currentSessionsDir = join(
            testDir,
            'sessions',
            String(now.getFullYear()),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0')
        );
        await mkdir(currentSessionsDir, { recursive: true });

        const firstSessionId = 'session-reused-a';
        const secondSessionId = 'session-reused-b';
        const firstFile = join(currentSessionsDir, `codex-${firstSessionId}.jsonl`);
        const secondFile = join(currentSessionsDir, `codex-${secondSessionId}.jsonl`);
        const oldTimestamp = new Date(startupTimestampMs - 10 * 60 * 1000).toISOString();

        await writeFile(
            firstFile,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: firstSessionId, cwd: targetCwd, timestamp: oldTimestamp }
            }) + '\n'
        );
        await writeFile(
            secondFile,
            JSON.stringify({
                type: 'session_meta',
                payload: { id: secondSessionId, cwd: targetCwd, timestamp: oldTimestamp }
            }) + '\n'
        );

        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: null,
            cwd: targetCwd,
            startupTimestampMs,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            }
        });

        await wait(150);
        expect(matchedSessionId).toBeNull();

        const firstNewLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-a-1', arguments: '{}' }
        });
        const secondNewLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-b-1', arguments: '{}' }
        });
        await appendFile(firstFile, firstNewLine + '\n');
        await appendFile(secondFile, secondNewLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);

        const laterUniqueLine = JSON.stringify({
            type: 'response_item',
            payload: { type: 'function_call', name: 'Tool', call_id: 'call-reused-a-2', arguments: '{}' }
        });
        await appendFile(firstFile, laterUniqueLine + '\n');

        await wait(2300);
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);
    });
});
