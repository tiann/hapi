import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importCodexSessionHistory } from './importHistory';
import type { ApiSessionClient } from '@/lib';
import type { Metadata } from '@hapi/protocol';

describe('importCodexSessionHistory', () => {
    const originalCodexHome = process.env.CODEX_HOME;
    let codexHome: string;

    beforeEach(async () => {
        codexHome = join(tmpdir(), `hapi-codex-history-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        process.env.CODEX_HOME = codexHome;
        await mkdir(join(codexHome, 'sessions', '2026', '04', '27'), { recursive: true });
    });

    afterEach(async () => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }
        await rm(codexHome, { recursive: true, force: true });
    });

    it('imports user and agent messages from the matching Codex transcript', async () => {
        const transcriptPath = join(codexHome, 'sessions', '2026', '04', '27', 'session.jsonl');
        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'old prompt' } }),
                JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'old answer' } })
            ].join('\n') + '\n'
        );
        await writeFile(
            join(codexHome, 'session_index.jsonl'),
            `${JSON.stringify({ id: 'thread-1', thread_name: 'codex generated title', updated_at: '2026-04-27T00:00:00.000Z' })}\n`
        );

        const userMessages: string[] = [];
        const agentMessages: unknown[] = [];
        const updateMetadata = vi.fn();
        const session = {
            updateMetadata,
            sendUserMessage: (message: string) => userMessages.push(message),
            sendAgentMessage: (message: unknown) => agentMessages.push(message),
        } as unknown as ApiSessionClient;

        const result = await importCodexSessionHistory({
            session,
            codexSessionId: 'thread-1',
        });

        expect(result).toEqual({ imported: 2, filePath: transcriptPath });
        expect(updateMetadata).toHaveBeenCalledTimes(2);
        const metadata = updateMetadata.mock.calls.reduce<Metadata>(
            (current, call) => call[0](current),
            { path: '/repo', host: 'test' }
        );
        expect(metadata).toMatchObject({
            codexSessionId: 'thread-1',
            summary: { text: 'codex generated title' }
        });
        expect(userMessages).toEqual(['old prompt']);
        expect(agentMessages).toMatchObject([
            { type: 'message', message: 'old answer' }
        ]);
    });

    it('restores Codex session metadata from transcript model, reasoning effort, and latest usage', async () => {
        const transcriptPath = join(codexHome, 'sessions', '2026', '04', '27', 'session.jsonl');
        await writeFile(
            transcriptPath,
            [
                JSON.stringify({ type: 'session_meta', payload: { id: 'thread-usage', model: 'gpt-5.4' } }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'turn_context',
                        model: 'gpt-5.4',
                        reasoning_effort: 'high'
                    }
                }),
                JSON.stringify({
                    type: 'event_msg',
                    payload: {
                        type: 'token_count',
                        info: {
                            model_context_window: 100_000,
                            total_token_usage: {
                                input_tokens: 1000,
                                cached_input_tokens: 500,
                                output_tokens: 250,
                                reasoning_output_tokens: 250,
                                total_tokens: 2000
                            }
                        },
                        rate_limits: {
                            primary: {
                                used_percent: 25,
                                window_minutes: 300
                            }
                        }
                    }
                })
            ].join('\n') + '\n'
        );

        const updateMetadata = vi.fn();
        const applySessionConfig = vi.fn();
        const session = {
            updateMetadata,
            applySessionConfig,
            sendUserMessage: vi.fn(),
            sendAgentMessage: vi.fn(),
        } as unknown as ApiSessionClient;

        const result = await importCodexSessionHistory({
            session,
            codexSessionId: 'thread-usage',
        });

        expect(result).toMatchObject({
            imported: 1,
            filePath: transcriptPath,
            model: 'gpt-5.4',
            modelReasoningEffort: 'high'
        });
        expect(applySessionConfig).toHaveBeenCalledWith({
            model: 'gpt-5.4',
            modelReasoningEffort: 'high'
        });
        const metadata = updateMetadata.mock.calls.reduce<Metadata>(
            (current, call) => call[0](current),
            { path: '/repo', host: 'test' }
        );
        expect(metadata).toMatchObject({
            codexSessionId: 'thread-usage',
            codexUsage: {
                contextWindow: {
                    usedTokens: 2000,
                    limitTokens: 100_000,
                    percent: 2
                },
                rateLimits: {
                    fiveHour: {
                        usedPercent: 25,
                        windowMinutes: 300
                    }
                },
                totalTokenUsage: {
                    inputTokens: 1000,
                    cachedInputTokens: 500,
                    outputTokens: 250,
                    reasoningOutputTokens: 250,
                    totalTokens: 2000
                }
            }
        });
    });
});
