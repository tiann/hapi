import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Store } from '../store'
import { getUsageSummary } from './usageService'

function addAgentMessage(store: Store, sessionId: string, content: unknown, createdAt?: number): void {
    if (createdAt === undefined) {
        store.messages.addMessage(sessionId, { role: 'agent', content })
        return
    }
    store.messages.copyMessageToSession(sessionId, {
        content: { role: 'agent', content },
        createdAt,
        localId: null,
        invokedAt: createdAt,
        scheduledAt: null
    })
}

describe('usage service', () => {
    it('normalizes historical Claude input that excludes cached tokens', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'claude-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        )

        addAgentMessage(store, session.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'claude-message',
                    model: 'claude-test',
                    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 80 }
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'claude-message',
                    model: 'claude-test',
                    usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 90 }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(1)
        expect(result.totals.inputTokens).toBe(102)
        expect(result.totals.outputTokens).toBe(3)
        expect(result.totals.cacheReadTokens).toBe(90)
        expect(result.totals.totalTokens).toBe(105)
        expect(result.totals.uncachedTokens).toBe(15)
        expect(result.byModel.find((row) => row.key === 'claude-test')?.totalTokens).toBe(105)
        store.close()
    })

    it('normalizes historical Codex cumulative usage with inclusive input', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-usage-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'test-model'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                scope_role: 'parent',
                info: {
                    total_token_usage: { input_tokens: 1_000, output_tokens: 100, cached_input_tokens: 800 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-2',
                turn_id: 'turn-1',
                scope_role: 'parent',
                info: {
                    total_token_usage: { input_tokens: 1_000, output_tokens: 100, cached_input_tokens: 800 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-2',
                scope_role: 'parent',
                info: {
                    total_token_usage: { input_tokens: 1_140, output_tokens: 115, cached_input_tokens: 900 },
                    last_token_usage: { input_tokens: 140, output_tokens: 15, cached_input_tokens: 100 }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(240)
        expect(result.totals.outputTokens).toBe(25)
        expect(result.totals.cacheReadTokens).toBe(180)
        expect(result.totals.totalTokens).toBe(265)
        expect(result.totals.uncachedTokens).toBe(85)
        store.close()
    })

    it('normalizes historical Kimi usage totals as inclusive per-request deltas', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'kimi-usage-test',
            { path: '/tmp', host: 'test', flavor: 'kimi' },
            null,
            'default',
            'kimi-model'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: { total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 } }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: { total: { inputTokens: 140, outputTokens: 15, cachedInputTokens: 100 } }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(240)
        expect(result.totals.outputTokens).toBe(25)
        expect(result.totals.cacheReadTokens).toBe(180)
        expect(result.totals.totalTokens).toBe(265)
        expect(result.totals.uncachedTokens).toBe(85)
        store.close()
    })

    it('recognizes the model-bearing historical generic ACP wire as inclusive', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-cache-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'acp-model',
                info: {
                    total: {
                        inputTokens: 13_879,
                        outputTokens: 2,
                        cachedInputTokens: 5_760
                    }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.inputTokens).toBe(13_879)
        expect(result.totals.cacheReadTokens).toBe(5_760)
        expect(result.totals.totalTokens).toBe(13_881)
        expect(result.totals.uncachedTokens).toBe(8_121)
        store.close()
    })

    it('falls back to legacy provenance when v1 usage semantics are malformed', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'malformed-generic-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'unknown',
                info: {
                    total: {
                        inputTokens: 100,
                        outputTokens: 20,
                        cachedInputTokens: 40,
                        cacheWriteInputTokens: 10
                    }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 150,
            cacheReadTokens: 40,
            cacheCreationTokens: 10,
            totalTokens: 170
        }))
        store.close()
    })

    it('repairs unmarked legacy generic ACP input that excluded cache', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'legacy-generic-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: { total: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80, cacheWriteInputTokens: 20 } }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.inputTokens).toBe(200)
        expect(result.totals.cacheReadTokens).toBe(80)
        expect(result.totals.cacheCreationTokens).toBe(20)
        expect(result.totals.uncachedTokens).toBe(125)
        store.close()
    })

    it('normalizes mixed legacy and marked generic usage per message in one session', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'mixed-generic-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const messages = [
            { type: 'token_count', info: { total: { inputTokens: 100, outputTokens: 5, cachedInputTokens: 80 } } },
            { type: 'token_count', usageSchema: 'hapi.usage.v1', inputTokenSemantics: 'includes-cache', info: { total: { inputTokens: 180, outputTokens: 5, cachedInputTokens: 80 } } },
            { type: 'token_count', model: null, info: { total: { inputTokens: 180, outputTokens: 5, cachedInputTokens: 80 } } }
        ]
        for (const data of messages) addAgentMessage(store, session.id, { type: 'codex', data })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.inputTokens).toBe(540)
        expect(result.totals.outputTokens).toBe(15)
        expect(result.totals.cacheReadTokens).toBe(240)
        expect(result.totals.requests).toBe(3)
        store.close()
    })

    it('uses the explicit v1 generic usage input semantics without double-counting cache', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'generic-v1-usage-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default',
            'acp-model'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'includes-cache',
                info: {
                    total: {
                        inputTokens: 150,
                        outputTokens: 20,
                        cachedInputTokens: 40,
                        cacheWriteInputTokens: 10
                    }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 150,
            outputTokens: 20,
            cacheReadTokens: 40,
            cacheCreationTokens: 10,
            totalTokens: 170,
            uncachedTokens: 130,
            requests: 1
        }))
        store.close()
    })

    it('normalizes cumulative total and last snapshots with the same declared semantics', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-exclusive-cumulative-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default'
        )
        const snapshots = [
            {
                total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
                last: { inputTokens: 20, outputTokens: 2, cachedInputTokens: 10 }
            },
            {
                total: { inputTokens: 130, outputTokens: 15, cachedInputTokens: 100 },
                last: { inputTokens: 30, outputTokens: 5, cachedInputTokens: 20 }
            }
        ]
        snapshots.forEach((info, index) => addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'excludes-cache',
                threadId: 'thread-exclusive',
                turnId: `turn-${index}`,
                info
            }
        }))

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 80,
            outputTokens: 7,
            cacheReadTokens: 30,
            requests: 2
        }))
        store.close()
    })

    it('treats a cumulative counter reset as a whole-snapshot reset', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-whole-reset-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default'
        )
        const snapshots = [
            {
                total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 },
                last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }
            },
            {
                // Only input/cache regressed; output alone still increased.
                total: { inputTokens: 50, outputTokens: 70, cachedInputTokens: 40 },
                last: { inputTokens: 50, outputTokens: 7, cachedInputTokens: 40 }
            }
        ]
        snapshots.forEach((info, index) => addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                threadId: 'thread-reset',
                turnId: `turn-${index}`,
                info
            }
        }))

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 150,
            outputTokens: 27,
            cacheReadTokens: 120,
            requests: 2
        }))
        store.close()
    })

    it('preserves primary usage and requests when the cache partition is impossible', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'invalid-cache-partition-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'usage',
                usageSchema: 'hapi.usage.v1',
                inputTokenSemantics: 'includes-cache',
                inputTokens: 100,
                outputTokens: 20,
                cachedInputTokens: 120,
                cacheWriteInputTokens: 5
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals).toEqual(expect.objectContaining({
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            totalTokens: 120,
            uncachedTokens: 120,
            requests: 1
        }))
        expect(result.totals.sessions).toBe(1)
        store.close()
    })

    it('falls back to the session model for Codex events without a model', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-last-usage-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'deepseek-v4-flash[1m]'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(1)
        expect(result.totals.totalTokens).toBe(110)
        expect(result.totals.uncachedTokens).toBe(30)
        expect(result.byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash[1m]', totalTokens: 110 })
        ])
        store.close()
    })

    it('preserves an indexed fallback model across session model changes', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-model-fallback-rebuild-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'deepseek-v4-flash'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 10 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10 }
                }
            }
        })

        expect(getUsageSummary(store, 'default', 'all').byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash', totalTokens: 110 })
        ])

        store.sessions.setSessionModel(session.id, 'gpt-5.6-sol', 'default')
        store.messages.bumpMessageEpoch(session.id)

        expect(getUsageSummary(store, 'default', 'all').byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash', totalTokens: 110 })
        ])
        store.close()
    })

    it('replaces a cumulative fallback model when a replay adds an explicit model', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-explicit-model-replay-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'deepseek-v4-flash'
        )
        const tokenCount = (model?: string) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                model,
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 10 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10 }
                }
            }
        })

        addAgentMessage(store, session.id, tokenCount())
        expect(getUsageSummary(store, 'default', 'all').byModel).toEqual([
            expect.objectContaining({ key: 'deepseek-v4-flash', totalTokens: 110, requests: 1 })
        ])

        addAgentMessage(store, session.id, tokenCount('gpt-5.6-sol'))
        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals).toEqual(expect.objectContaining({ totalTokens: 110, requests: 1 }))
        expect(result.byModel).toEqual([
            expect.objectContaining({ key: 'gpt-5.6-sol', totalTokens: 110, requests: 1 })
        ])
        store.close()
    })

    it('preserves event-level models across model switches and epoch rebuilds', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'codex-model-switch-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'initial-model'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'old-model',
                thread_id: 'thread-1',
                turn_id: 'turn-1',
                info: {
                    total_token_usage: { input_tokens: 100, output_tokens: 10 },
                    last_token_usage: { input_tokens: 100, output_tokens: 10 }
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'new-model',
                thread_id: 'thread-1',
                turn_id: 'turn-2',
                info: {
                    total_token_usage: { input_tokens: 140, output_tokens: 15 },
                    last_token_usage: { input_tokens: 40, output_tokens: 5 }
                }
            }
        })
        store.sessions.setSessionModel(session.id, 'latest-session-model', 'default')

        const expectedModels = [
            expect.objectContaining({ key: 'old-model', totalTokens: 110 }),
            expect.objectContaining({ key: 'new-model', totalTokens: 45 })
        ]
        expect(getUsageSummary(store, 'default', 'all').byModel).toEqual(expectedModels)

        store.messages.bumpMessageEpoch(session.id)
        expect(getUsageSummary(store, 'default', 'all').byModel).toEqual(expectedModels)
        store.close()
    })

    it('buckets historical usage with the event-specific DST offset', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'timezone-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default'
        )
        const usage = (id: string) => ({
            type: 'output',
            data: {
                type: 'assistant',
                message: { id, usage: { input_tokens: 10, output_tokens: 2 } }
            }
        })
        addAgentMessage(store, session.id, usage('before-dst'), Date.parse('2026-03-07T04:30:00Z'))
        addAgentMessage(store, session.id, usage('after-dst'), Date.parse('2026-03-09T04:30:00Z'))

        expect(getUsageSummary(store, 'default', 'all', 'America/New_York').daily.map((row) => row.key)).toEqual([
            '2026-03-06',
            '2026-03-09'
        ])
        store.close()
    })

    it('resumes scanning after the last checked message and resets after an epoch change', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'incremental-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        )
        store.messages.addMessage(session.id, { role: 'user', content: { type: 'text', text: 'hello' } })

        const afterSeqs: number[] = []
        const getMessagesAfterSeq = store.messages.getMessagesAfterSeq.bind(store.messages)
        store.messages.getMessagesAfterSeq = (sessionId, afterSeq) => {
            afterSeqs.push(afterSeq)
            return getMessagesAfterSeq(sessionId, afterSeq)
        }

        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(0)
        addAgentMessage(store, session.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'incremental-claude-message',
                    usage: { input_tokens: 5, output_tokens: 2 }
                }
            }
        })
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)

        store.messages.bumpMessageEpoch(session.id)
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
        expect(afterSeqs).toEqual([0, 1, 0])
        store.close()
    })

    it('removes usage from transcript history discarded by a rewind', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'rewound-usage-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        )
        const claudeUsage = (id: string) => ({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    message: { id, usage: { input_tokens: 10, output_tokens: 2 } }
                }
            }
        })

        store.messages.addMessage(session.id, claudeUsage('kept-message'))
        store.messages.addMessage(
            session.id,
            { role: 'user', content: { type: 'text', text: 'retry this' } },
            'rewind-point'
        )
        store.messages.addMessage(session.id, claudeUsage('discarded-message'))
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(2)

        const result = store.messages.truncateMessagesFromLocalId(session.id, 'rewind-point')
        expect(result.deleted).toBe(2)
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)
        expect(store.usage.getEvents([session.id])).toHaveLength(1)
        store.close()
    })

    it('does not deduplicate matching Codex turns from different sessions', () => {
        const store = new Store(':memory:')
        for (const [sessionId, threadId] of [['codex-session-1', 'thread-1'], ['codex-session-2', 'thread-2']] as const) {
            const session = store.sessions.getOrCreateSession(
                sessionId,
                { path: '/tmp', host: 'test', flavor: 'codex' },
                null,
                'default',
                'test-model'
            )
            addAgentMessage(store, session.id, {
                type: 'codex',
                data: {
                    type: 'token_count',
                    thread_id: threadId,
                    turn_id: 'matching-turn',
                    scope_role: 'parent',
                    info: {
                        total_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 },
                        last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80 }
                    }
                }
            })
        }

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(2)
        expect(result.totals.totalTokens).toBe(220)
        store.close()
    })

    it('deduplicates repeated cumulative snapshots without thread metadata', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'imported-codex-usage-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'test-model'
        )
        const snapshots = [
            {
                total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 },
                last: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 80 }
            },
            {
                total: { inputTokens: 140, outputTokens: 15, cachedInputTokens: 100 },
                last: { inputTokens: 40, outputTokens: 5, cachedInputTokens: 20 }
            }
        ]
        for (const info of [...snapshots, ...snapshots]) {
            addAgentMessage(store, session.id, {
                type: 'codex',
                data: { type: 'token_count', info }
            })
        }

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(140)
        expect(result.totals.outputTokens).toBe(15)
        expect(result.totals.uncachedTokens).toBe(55)
        store.close()
    })

    it('excludes pre-HAPI Codex transcript usage from imported sessions', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'resumed-codex-usage-test',
            {
                path: '/tmp',
                host: 'test',
                flavor: 'codex',
                codexSessionId: 'forked-thread',
                codexSourceSessionId: 'imported-thread'
            },
            null,
            'default',
            'test-model'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                info: {
                    total_token_usage: { input_tokens: 1_000_000, output_tokens: 10_000, cached_input_tokens: 900_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000, cached_input_tokens: 90_000 }
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                thread_id: 'forked-thread',
                turn_id: 'managed-turn',
                info: {
                    total_token_usage: { input_tokens: 1_100_000, output_tokens: 11_000, cached_input_tokens: 990_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000, cached_input_tokens: 90_000 }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(1)
        expect(result.totals.totalTokens).toBe(101_000)
        expect(result.totals.uncachedTokens).toBe(11_000)
        store.close()
    })

    it('excludes transcript replay events explicitly marked by the CLI', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'marked-codex-history-test',
            { path: '/tmp', host: 'test', flavor: 'codex' },
            null,
            'default',
            'test-model'
        )

        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                hapiUsageScope: 'imported-history',
                info: {
                    total_token_usage: { input_tokens: 1_000_000, output_tokens: 10_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000 }
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                hapiUsageScope: 'managed',
                thread_id: 'resumed-thread',
                info: {
                    total_token_usage: { input_tokens: 1_100_000, output_tokens: 11_000 },
                    last_token_usage: { input_tokens: 100_000, output_tokens: 1_000 }
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(1)
        expect(result.totals.totalTokens).toBe(101_000)
        store.close()
    })

    it('keeps usage counted once when session history is merged', () => {
        const store = new Store(':memory:')
        const source = store.sessions.getOrCreateSession(
            'usage-merge-source',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        )
        const target = store.sessions.getOrCreateSession(
            'usage-merge-target',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        )
        addAgentMessage(store, source.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: {
                    id: 'moved-claude-message',
                    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 80 }
                }
            }
        })
        expect(getUsageSummary(store, 'default', 'all').totals.requests).toBe(1)

        const moved = store.messages.mergeSessionMessages(source.id, target.id)
        expect(moved.moved).toBe(1)
        store.usage.transferSession(source.id, target.id)

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(1)
        expect(store.usage.getEvents([source.id])).toEqual([])
        expect(store.usage.getEvents([target.id])).toHaveLength(1)
        store.close()
    })

    it('marks an ACP agent as context-only when it reports context without tokens', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-context-only-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default',
            'some-model'
        )
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'some-model',
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 4_200,
                    modelContextWindow: 200_000
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(0)
        expect(result.totals.totalTokens).toBe(0)
        expect(result.totals.costs).toEqual([])
        expect(result.agents).toEqual([
            expect.objectContaining({ agent: 'opencode', status: 'context-only', sessions: 1, costs: [] })
        ])
        store.close()
    })

    it('treats an explicit zero context or a context window alone as context presence', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-zero-context-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default',
            'some-model'
        )
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                model: 'some-model',
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 0,
                    modelContextWindow: 200_000
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.agents).toEqual([
            expect.objectContaining({ agent: 'opencode', status: 'context-only', sessions: 1 })
        ])
        store.close()
    })

    it('keeps costs per currency instead of collapsing them into one scalar', () => {        const store = new Store(':memory:')
        const usdSession = store.sessions.getOrCreateSession(
            'acp-cost-usd-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const eurSession = store.sessions.getOrCreateSession(
            'acp-cost-eur-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const costMessage = (cost: number, currency: string) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                cost,
                costCurrency: currency,
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_000,
                    modelContextWindow: 200_000
                }
            }
        })
        addAgentMessage(store, usdSession.id, costMessage(1, 'USD'))
        addAgentMessage(store, eurSession.id, costMessage(1, 'EUR'))

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.costs).toEqual([
            { amount: 1, currency: 'EUR' },
            { amount: 1, currency: 'USD' }
        ])
        expect(result.agents).toEqual([
            expect.objectContaining({ agent: 'opencode', status: 'cost-only', costs: [
                { amount: 1, currency: 'EUR' },
                { amount: 1, currency: 'USD' }
            ] })
        ])
        store.close()
    })

    it('derives bounded-range cost from the cumulative baseline', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-cost-range-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const costMessage = (cost: number, currency: string) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                cost,
                costCurrency: currency,
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_000,
                    modelContextWindow: 200_000
                }
            }
        })
        const day = 24 * 60 * 60 * 1000
        // USD 10 was already spent before the 7-day window; USD 11 is the
        // cumulative total now. The 7-day view must show the USD 1 growth,
        // while the all-time view shows the full USD 11.
        addAgentMessage(store, session.id, costMessage(10, 'USD'), Date.now() - 10 * day)
        addAgentMessage(store, session.id, costMessage(11, 'USD'))

        const sevenDay = getUsageSummary(store, 'default', '7d')
        expect(sevenDay.totals.costs).toEqual([{ amount: 1, currency: 'USD' }])
        const allTime = getUsageSummary(store, 'default', 'all')
        expect(allTime.totals.costs).toEqual([{ amount: 11, currency: 'USD' }])
        store.close()
    })

    it('keeps known in-range growth after an old session first reports cost inside the range', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-cost-old-session-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const day = 24 * 60 * 60 * 1000
        // The session predates the 7-day window, so its first in-range sample
        // cannot be attributed. Later in-range growth is still measurable.
        const internalDb = (store as unknown as { db: Database }).db
        internalDb.prepare('UPDATE sessions SET created_at = ? WHERE id = ?')
            .run(Date.now() - 30 * day, session.id)
        const costMessage = (cost: number) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                cost,
                costCurrency: 'USD',
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_000,
                    modelContextWindow: 200_000
                }
            }
        })
        addAgentMessage(store, session.id, costMessage(5), Date.now() - 2 * day)
        addAgentMessage(store, session.id, costMessage(6), Date.now() - day)

        const sevenDay = getUsageSummary(store, 'default', '7d')
        expect(sevenDay.totals.costs).toEqual([{ amount: 1, currency: 'USD' }])
        const allTime = getUsageSummary(store, 'default', 'all')
        expect(allTime.totals.costs).toEqual([{ amount: 6, currency: 'USD' }])
        store.close()
    })

    it('preserves spend across cumulative-cost resets', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-cost-reset-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const costMessage = (cost: number) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                cost,
                costCurrency: 'USD',
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_000,
                    modelContextWindow: 200_000
                }
            }
        })
        const day = 24 * 60 * 60 * 1000
        // 10 -> 11 accumulates 1; the drop to 2 is a provider reset that
        // restarts the counter, so 2 more counts. All-time total: 13.
        addAgentMessage(store, session.id, costMessage(10), Date.now() - 10 * day)
        addAgentMessage(store, session.id, costMessage(11), Date.now() - 2 * day)
        addAgentMessage(store, session.id, costMessage(2))

        const allTime = getUsageSummary(store, 'default', 'all')
        expect(allTime.totals.costs).toEqual([{ amount: 13, currency: 'USD' }])
        // 7-day view: baseline 10, in-range 11 -> 2 is 1 + 2 = 3.
        const sevenDay = getUsageSummary(store, 'default', '7d')
        expect(sevenDay.totals.costs).toEqual([{ amount: 3, currency: 'USD' }])
        store.close()
    })

    it('omits a session cost whose baseline currency changed inside the range', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-cost-currency-switch-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const costMessage = (cost: number, currency: string) => ({
            type: 'codex',
            data: {
                type: 'token_count',
                cost,
                costCurrency: currency,
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_000,
                    modelContextWindow: 200_000
                }
            }
        })
        const day = 24 * 60 * 60 * 1000
        addAgentMessage(store, session.id, costMessage(10, 'USD'), Date.now() - 10 * day)
        addAgentMessage(store, session.id, costMessage(2, 'EUR'))

        const sevenDay = getUsageSummary(store, 'default', '7d')
        expect(sevenDay.totals.costs).toEqual([])
        store.close()
    })

    it('records cumulative ACP cost once per session and marks cost-only agents', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-cost-only-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                cost: 1.25,
                costCurrency: 'USD',
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_000,
                    modelContextWindow: 200_000
                }
            }
        }, Date.now() - 60_000)
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                cost: 2.5,
                costCurrency: 'USD',
                info: {
                    total: { inputTokens: 0, outputTokens: 0 },
                    contextTokens: 1_200,
                    modelContextWindow: 200_000
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.costs).toEqual([{ amount: 2.5, currency: 'USD' }])
        expect(result.totals.requests).toBe(0)
        expect(result.agents).toEqual([
            expect.objectContaining({ agent: 'opencode', status: 'cost-only', costs: [{ amount: 2.5, currency: 'USD' }] })
        ])
        store.close()
    })

    it('keeps cost separate from token events and counts the latest cost once per session', () => {
        const store = new Store(':memory:')
        const session = store.sessions.getOrCreateSession(
            'acp-tokens-plus-cost-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default',
            'some-model'
        )
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                cost: 0.5,
                costCurrency: 'USD',
                info: {
                    total: { inputTokens: 100, outputTokens: 20 },
                    contextTokens: 4_200,
                    modelContextWindow: 200_000
                }
            }
        })
        addAgentMessage(store, session.id, {
            type: 'codex',
            data: {
                type: 'token_count',
                cost: 1.1,
                costCurrency: 'USD',
                info: {
                    total: { inputTokens: 60, outputTokens: 15 },
                    contextTokens: 5_000,
                    modelContextWindow: 200_000
                }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.totals.requests).toBe(2)
        expect(result.totals.inputTokens).toBe(160)
        expect(result.totals.outputTokens).toBe(35)
        // Cumulative cost is not a per-turn delta: the latest value wins.
        expect(result.totals.costs).toEqual([{ amount: 1.1, currency: 'USD' }])
        expect(result.agents).toEqual([
            expect.objectContaining({ agent: 'opencode', status: 'complete', costs: [{ amount: 1.1, currency: 'USD' }] })
        ])
        store.close()
    })

    it('reports agents without any usage events as not-reported', () => {
        const store = new Store(':memory:')
        const silent = store.sessions.getOrCreateSession(
            'acp-silent-test',
            { path: '/tmp', host: 'test', flavor: 'opencode' },
            null,
            'default'
        )
        const reporting = store.sessions.getOrCreateSession(
            'acp-reporting-test',
            { path: '/tmp', host: 'test', flavor: 'claude' },
            null,
            'default',
            'test-model'
        )
        addAgentMessage(store, reporting.id, {
            type: 'output',
            data: {
                type: 'assistant',
                message: { id: 'claude-usage', usage: { input_tokens: 10, output_tokens: 2 } }
            }
        })

        const result = getUsageSummary(store, 'default', 'all')
        expect(result.agents).toEqual([
            expect.objectContaining({ agent: 'claude', status: 'complete', sessions: 1 }),
            expect.objectContaining({ agent: 'opencode', status: 'not-reported', sessions: 1, costs: [] })
        ])
        expect(result.totals.costs).toEqual([])
        store.close()
    })
})
