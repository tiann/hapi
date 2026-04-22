import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listImportableCodexSessions } from './listImportableCodexSessions';

describe('listImportableCodexSessions', () => {
    let testDir: string;
    let sessionsRoot: string;

    beforeEach(async () => {
        testDir = join(tmpdir(), `codex-importable-sessions-${Date.now()}`);
        sessionsRoot = join(testDir, 'sessions');
        await mkdir(sessionsRoot, { recursive: true });
    });

    afterEach(async () => {
        if (existsSync(testDir)) {
            await rm(testDir, { recursive: true, force: true });
        }
    });

    it('filters child lineage blocks based on the current main segment and sorts recent-first', async () => {
        const olderDir = join(sessionsRoot, '2026', '04', '03');
        const newerDir = join(sessionsRoot, '2026', '04', '04');
        await mkdir(olderDir, { recursive: true });
        await mkdir(newerDir, { recursive: true });

        const currentMainSessionId = 'main-current-session';
        const currentMainFile = join(olderDir, `codex-${currentMainSessionId}.jsonl`);
        await writeFile(
            currentMainFile,
            [
                JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        id: 'child-lineage-session',
                        cwd: '/work/alpha',
                        timestamp: '2026-04-03T09:00:00.000Z',
                        source: {
                            subagent: {
                                thread_spawn: {
                                    parent_thread_id: 'parent-thread-1'
                                }
                            }
                        }
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'user_message',
                        message: 'ignored child prompt'
                    }
                }),
                JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        id: currentMainSessionId,
                        cwd: '/work/alpha',
                        timestamp: '2026-04-03T10:00:00.000Z'
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'user_message',
                        content: [
                            { type: 'text', text: '  build the alpha tools  ' },
                            { type: 'text', text: 'now' }
                        ]
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'session_title_change',
                        title: 'Alpha draft title'
                    }
                }),
                JSON.stringify({
                    type: 'response_item',
                    payload: {
                        type: 'function_call',
                        name: 'mcp__hapi__change_title',
                        call_id: 'title-call-1',
                        arguments: JSON.stringify({
                            title: [
                                { type: 'text', text: 'Alpha final' },
                                { type: 'text', text: 'title' }
                            ]
                        })
                    }
                })
            ].join('\n') + '\n'
        );

        const malformedLeadingLineSessionId = 'malformed-leading-line-session';
        const malformedLeadingLineFile = join(olderDir, `codex-${malformedLeadingLineSessionId}.jsonl`);
        await writeFile(
            malformedLeadingLineFile,
            [
                '{not valid json',
                JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        id: malformedLeadingLineSessionId,
                        cwd: '/work/malformed',
                        timestamp: '2026-04-03T09:30:00.000Z'
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'user_message',
                        message: [
                            { type: 'text', text: 'recoverable' },
                            { type: 'text', text: 'transcript' }
                        ]
                    }
                })
            ].join('\n') + '\n'
        );

        const childSessionId = 'child-session';
        const childFile = join(olderDir, `codex-${childSessionId}.jsonl`);
        await writeFile(
            childFile,
            [
                JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        id: childSessionId,
                        cwd: '/work/alpha',
                        timestamp: '2026-04-03T11:00:00.000Z',
                        source: {
                            subagent: {
                                thread_spawn: {
                                    parent_thread_id: 'parent-thread-1'
                                }
                            }
                        }
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'user_message',
                        message: 'delegate this'
                    }
                })
            ].join('\n') + '\n'
        );

        const newerSessionId = 'main-new-session';
        const newerFile = join(newerDir, `codex-${newerSessionId}.jsonl`);
        await writeFile(
            newerFile,
            [
                JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        id: newerSessionId,
                        cwd: '/work/beta/project',
                        timestamp: '2026-04-04T08:15:00.000Z'
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'user_message',
                        message: 'What should we build?'
                    }
                })
            ].join('\n') + '\n'
        );

        const fallbackSessionId = 'fallback-session';
        const fallbackFile = join(newerDir, `codex-${fallbackSessionId}.jsonl`);
        await writeFile(
            fallbackFile,
            [
                JSON.stringify({
                    type: 'session_meta',
                    payload: {
                        id: fallbackSessionId,
                        cwd: '/work/gamma',
                        timestamp: '2026-04-02T09:30:00.000Z'
                    }
                })
            ].join('\n') + '\n'
        );

        const result = await listImportableCodexSessions({ rootDir: sessionsRoot });

        expect(result.sessions.map((session) => session.externalSessionId)).toEqual([
            newerSessionId,
            currentMainSessionId,
            malformedLeadingLineSessionId,
            fallbackSessionId
        ]);

        expect(result.sessions[0]).toMatchObject({
            agent: 'codex',
            externalSessionId: newerSessionId,
            cwd: '/work/beta/project',
            timestamp: Date.parse('2026-04-04T08:15:00.000Z'),
            transcriptPath: newerFile,
            previewTitle: 'What should we build?',
            previewPrompt: 'What should we build?'
        });

        expect(result.sessions[1]).toMatchObject({
            agent: 'codex',
            externalSessionId: currentMainSessionId,
            cwd: '/work/alpha',
            timestamp: Date.parse('2026-04-03T10:00:00.000Z'),
            transcriptPath: currentMainFile,
            previewTitle: 'Alpha final title',
            previewPrompt: 'build the alpha tools now'
        });

        expect(result.sessions[2]).toMatchObject({
            agent: 'codex',
            externalSessionId: malformedLeadingLineSessionId,
            cwd: '/work/malformed',
            timestamp: Date.parse('2026-04-03T09:30:00.000Z'),
            transcriptPath: malformedLeadingLineFile,
            previewTitle: 'recoverable transcript',
            previewPrompt: 'recoverable transcript'
        });

        expect(result.sessions[3]).toMatchObject({
            agent: 'codex',
            externalSessionId: fallbackSessionId,
            cwd: '/work/gamma',
            timestamp: Date.parse('2026-04-02T09:30:00.000Z'),
            transcriptPath: fallbackFile,
            previewTitle: 'gamma',
            previewPrompt: null
        });

        expect(result.sessions.find((session) => session.externalSessionId === childSessionId)).toBeUndefined();
    });
});
