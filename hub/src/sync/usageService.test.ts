import { describe, expect, it } from 'bun:test'
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
    it('deduplicates Claude stream fragments and normalizes cached input', () => {
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

    it('uses the latest request as the baseline for a resumed Codex thread', () => {
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

    it('treats ACP usage totals as per-request deltas', () => {
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

    it('counts normalized ACP cached input as processed input', () => {
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
})
