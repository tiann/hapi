import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { createCodexSessionScanner } from './codexSessionScanner';
import type { ResolveCodexSessionFileResult } from './resolveCodexSessionFile';
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

    it('enriches child transcript events and trims the copied parent prefix', async () => {
        const parentSessionId = 'parent-session-1';
        const parentToolCallId = 'spawn-call-1';
        const childSessionId = 'child-session-1';
        const parentFile = join(sessionsDir, `codex-${parentSessionId}.jsonl`);
        const childFile = join(sessionsDir, `codex-${childSessionId}.jsonl`);
        const resolvedResult: ResolveCodexSessionFileResult = {
            status: 'found',
            filePath: parentFile,
            cwd: '/data/github/happy/hapi',
            timestamp: Date.parse('2025-12-22T00:00:00.000Z')
        };

        await writeFile(
            parentFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: parentSessionId } }),
                JSON.stringify({
                    type: 'response_item',
                    payload: { type: 'function_call', name: 'spawn_agent', call_id: parentToolCallId, arguments: '{"message":"delegate"}' }
                })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: parentSessionId,
            resolvedSessionFile: resolvedResult,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(2);
        expect(events[0].type).toBe('session_meta');
        expect((events[0].payload as Record<string, unknown>).id).toBe(parentSessionId);
        expect(events[1].type).toBe('response_item');
        expect((events[1].payload as Record<string, unknown>).call_id).toBe(parentToolCallId);

        await appendFile(
            parentFile,
            [
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'function_call_output',
                        call_id: parentToolCallId,
                        output: JSON.stringify({ agent_id: childSessionId, nickname: 'child' })
                    }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: { type: 'function_call', name: 'wait_agent', call_id: 'wait-call-1', arguments: JSON.stringify({ targets: [childSessionId], timeout_ms: 30000 }) }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'function_call_output',
                        call_id: 'wait-call-1',
                        output: { status: { [childSessionId]: { completed: 'done' } } }
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: { type: 'user_message', message: '<subagent_notification>child done</subagent_notification>' }
                })
            ].join('\n') + '\n'
        );

        await wait(2300);
        expect(events.some((event) => event.type === 'response_item' && (event.payload as Record<string, unknown>).call_id === parentToolCallId)).toBe(true);
        expect(events.some((event) => event.type === 'response_item' && (event.payload as Record<string, unknown>).call_id === 'wait-call-1')).toBe(true);
        expect(events.some((event) => event.type === 'event_msg' && (event.payload as Record<string, unknown>).message === '<subagent_notification>child done</subagent_notification>')).toBe(true);

        for (const event of events) {
            expect((event as Record<string, unknown>).hapiSidechain).toBeUndefined();
        }

        await writeFile(
            childFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: childSessionId } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'copied parent prompt' } })
            ].join('\n') + '\n'
        );

        await wait(2300);

        expect(events.find((event) => (event.payload as Record<string, unknown>)?.message === 'copied parent prompt')).toBeUndefined();

        await appendFile(
            childFile,
            [
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'function_call_output',
                        call_id: 'bootstrap-call-1',
                        output: 'You are the newly spawned agent. The prior conversation history was forked from your parent agent. Treat the next user message as your new task, and use the forked history only as background context.'
                    }
                }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn-1' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'child prompt' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'child answer' } })
            ].join('\n') + '\n'
        );

        await wait(2300);

        const copiedPrefixEvent = events.find((event) => (event.payload as Record<string, unknown>)?.message === 'copied parent prompt');
        expect(copiedPrefixEvent).toBeUndefined();

        const childUserEvent = events.find((event) => (event.payload as Record<string, unknown>)?.message === 'child prompt');
        expect(childUserEvent).toBeDefined();
        expect((childUserEvent as Record<string, unknown>).hapiSidechain).toEqual({ parentToolCallId });

        const childAnswerEvent = events.find((event) => (event.payload as Record<string, unknown>)?.message === 'child answer');
        expect(childAnswerEvent).toBeDefined();
        expect((childAnswerEvent as Record<string, unknown>).hapiSidechain).toEqual({ parentToolCallId });

        const childSessionMetaEvent = events.find((event) => event.type === 'session_meta' && (event.payload as Record<string, unknown>).id === childSessionId);
        expect(childSessionMetaEvent).toBeUndefined();

        const parentWaitEvent = events.find((event) => event.type === 'response_item' && (event.payload as Record<string, unknown>).call_id === 'wait-call-1');
        expect((parentWaitEvent as Record<string, unknown>).hapiSidechain).toBeUndefined();
    }, 10000);

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

    it('explicit resume scans only the resolved file and ignores stray matching cwd files', async () => {
        const targetCwd = '/data/github/happy/hapi';
        const resolvedSessionId = 'session-explicit-resolved';
        const straySessionId = 'session-explicit-stray';
        const resolvedFile = join(sessionsDir, `codex-${resolvedSessionId}.jsonl`);
        const strayFile = join(sessionsDir, `codex-${straySessionId}.jsonl`);
        const resolvedResult: ResolveCodexSessionFileResult = {
            status: 'found',
            filePath: resolvedFile,
            cwd: targetCwd,
            timestamp: Date.parse('2025-12-22T00:00:00.000Z')
        };

        await writeFile(
            resolvedFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: resolvedSessionId, cwd: targetCwd, timestamp: '2025-12-22T00:00:00.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'resolved-initial' } })
            ].join('\n') + '\n'
        );
        await writeFile(
            strayFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: straySessionId, cwd: targetCwd, timestamp: '2025-12-22T00:00:00.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'stray-initial' } })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: resolvedSessionId,
            cwd: targetCwd,
            resolvedSessionFile: resolvedResult,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(2);
        expect(events[0].type).toBe('session_meta');
        expect(events[1].type).toBe('event_msg');
        expect((events[1].payload as Record<string, unknown>).message).toBe('resolved-initial');

        await appendFile(
            strayFile,
            JSON.stringify({
                type: 'response_item',
                payload: { type: 'function_call', name: 'Tool', call_id: 'call-stray', arguments: '{}' }
            }) + '\n'
        );
        await appendFile(
            resolvedFile,
            JSON.stringify({
                type: 'response_item',
                payload: { type: 'function_call', name: 'Tool', call_id: 'call-resolved', arguments: '{}' }
            }) + '\n'
        );

        await wait(2300);
        expect(events).toHaveLength(3);
        expect(events[2].type).toBe('response_item');
        expect((events[2].payload as Record<string, unknown>).call_id).toBe('call-resolved');
    });

    it('explicit resume replays a leading lineage block for the requested session', async () => {
        const targetCwd = '/data/github/happy/hapi';
        const requestedSessionId = 'session-explicit-current';
        const ancestorSessionId = 'session-explicit-ancestor';
        const resolvedFile = join(sessionsDir, `codex-${requestedSessionId}.jsonl`);
        const resolvedResult: ResolveCodexSessionFileResult = {
            status: 'found',
            filePath: resolvedFile,
            cwd: targetCwd,
            timestamp: Date.parse('2025-12-22T00:00:00.000Z')
        };

        await writeFile(
            resolvedFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: requestedSessionId, cwd: targetCwd, timestamp: '2025-12-22T00:00:00.000Z' } }),
                JSON.stringify({ type: 'session_meta', payload: { id: ancestorSessionId, cwd: targetCwd, timestamp: '2025-12-21T23:00:00.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'current-segment-message' } }),
                JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'Tool', call_id: 'call-current', arguments: '{}' } })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: requestedSessionId,
            cwd: targetCwd,
            resolvedSessionFile: resolvedResult,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(3);
        expect(events.map((event) => event.type)).toEqual(['session_meta', 'event_msg', 'response_item']);
        expect((events[0].payload as Record<string, unknown>).id).toBe(requestedSessionId);
        expect((events[1].payload as Record<string, unknown>).message).toBe('current-segment-message');
        expect((events[2].payload as Record<string, unknown>).call_id).toBe('call-current');
    });

    it('explicit resume emits only the matching segment when a later segment starts a new session', async () => {
        const targetCwd = '/data/github/happy/hapi';
        const firstSessionId = 'session-explicit-first';
        const secondSessionId = 'session-explicit-second';
        const resolvedFile = join(sessionsDir, `codex-${secondSessionId}.jsonl`);
        const resolvedResult: ResolveCodexSessionFileResult = {
            status: 'found',
            filePath: resolvedFile,
            cwd: targetCwd,
            timestamp: Date.parse('2025-12-22T01:00:00.000Z')
        };

        await writeFile(
            resolvedFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: firstSessionId, cwd: targetCwd, timestamp: '2025-12-22T00:00:00.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'first-segment-message' } }),
                JSON.stringify({ type: 'session_meta', payload: { id: secondSessionId, cwd: targetCwd, timestamp: '2025-12-22T01:00:00.000Z' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'second-segment-message' } }),
                JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'Tool', call_id: 'call-second', arguments: '{}' } })
            ].join('\n') + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: secondSessionId,
            cwd: targetCwd,
            resolvedSessionFile: resolvedResult,
            onEvent: (event) => events.push(event)
        });

        await wait(200);
        expect(events).toHaveLength(3);
        expect(events.map((event) => event.type)).toEqual(['session_meta', 'event_msg', 'response_item']);
        expect((events[0].payload as Record<string, unknown>).id).toBe(secondSessionId);
        expect((events[1].payload as Record<string, unknown>).message).toBe('second-segment-message');
        expect((events[2].payload as Record<string, unknown>).call_id).toBe('call-second');
    });

    it('explicit resume failure does not adopt another session', async () => {
        const targetCwd = '/data/github/happy/hapi';
        const requestedSessionId = 'session-explicit-missing';
        const fallbackSessionId = 'session-fallback-candidate';
        const fallbackFile = join(sessionsDir, `codex-${fallbackSessionId}.jsonl`);
        const resolverFailureResult: ResolveCodexSessionFileResult = {
            status: 'not_found'
        };

        await writeFile(
            fallbackFile,
            JSON.stringify({
                type: 'session_meta',
                payload: {
                    id: fallbackSessionId,
                    cwd: targetCwd,
                    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString()
                }
            }) + '\n'
        );

        let failureMessage: string | null = null;
        let matchedSessionId: string | null = null;
        scanner = await createCodexSessionScanner({
            sessionId: requestedSessionId,
            cwd: targetCwd,
            resolvedSessionFile: resolverFailureResult,
            onEvent: (event) => events.push(event),
            onSessionFound: (sessionId) => {
                matchedSessionId = sessionId;
            },
            onSessionMatchFailed: (message) => {
                failureMessage = message;
            }
        });

        await wait(200);
        expect(failureMessage).not.toBeNull();
        expect(matchedSessionId).toBeNull();
        expect(events).toHaveLength(0);

        await appendFile(
            fallbackFile,
            JSON.stringify({
                type: 'response_item',
                payload: { type: 'function_call', name: 'Tool', call_id: 'call-fallback', arguments: '{}' }
            }) + '\n'
        );

        await wait(2300);
        expect(failureMessage).not.toBeNull();
        expect(matchedSessionId).toBeNull();
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

    it('links child transcripts in non-explicit live session path', async () => {
        const parentSessionId = 'parent-live-1';
        const parentToolCallId = 'spawn-live-1';
        const childSessionId = 'child-live-1';
        const parentFile = join(sessionsDir, `codex-${parentSessionId}.jsonl`);
        const childFile = join(sessionsDir, `codex-${childSessionId}.jsonl`);

        await writeFile(
            parentFile,
            JSON.stringify({ type: 'session_meta', payload: { id: parentSessionId } }) + '\n'
        );

        scanner = await createCodexSessionScanner({
            sessionId: parentSessionId,
            onEvent: (event) => events.push(event)
        });

        await wait(200);

        await appendFile(
            parentFile,
            [
                JSON.stringify({
                    type: 'response_item',
                    payload: { type: 'function_call', name: 'spawn_agent', call_id: parentToolCallId, arguments: '{"message":"delegate"}' }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'function_call_output',
                        call_id: parentToolCallId,
                        output: JSON.stringify({ agent_id: childSessionId, nickname: 'child' })
                    }
                })
            ].join('\n') + '\n'
        );

        await wait(2500);

        await writeFile(
            childFile,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: childSessionId } }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'function_call_output',
                        call_id: 'bootstrap-1',
                        output: 'You are the newly spawned agent. The prior conversation history was forked from your parent agent. Treat the next user message as your new task, and use the forked history only as background context.'
                    }
                }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'child-turn-1' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'child prompt live' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'child answer live' } })
            ].join('\n') + '\n'
        );

        await wait(4500);

        const childUserEvent = events.find((event) => (event.payload as Record<string, unknown>)?.message === 'child prompt live');
        expect(childUserEvent).toBeDefined();
        expect((childUserEvent as Record<string, unknown>).hapiSidechain).toEqual({ parentToolCallId });

        const childAnswerEvent = events.find((event) => (event.payload as Record<string, unknown>)?.message === 'child answer live');
        expect(childAnswerEvent).toBeDefined();
        expect((childAnswerEvent as Record<string, unknown>).hapiSidechain).toEqual({ parentToolCallId });

        // Parent spawn call should not have sidechain metadata
        const spawnCall = events.find((event) =>
            event.type === 'response_item'
            && (event.payload as Record<string, unknown>)?.type === 'function_call'
            && (event.payload as Record<string, unknown>)?.call_id === parentToolCallId
        );
        expect(spawnCall).toBeDefined();
        expect((spawnCall as Record<string, unknown>).hapiSidechain).toBeUndefined();
    }, 15000);

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
