import { afterEach, describe, expect, it } from 'bun:test'
import { Store } from '../store'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { AutomaticTitleSuggestionService } from './automaticTitleSuggestion'
import { TitleSuggestionService } from './titleSuggestion'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
function makeStore(): Store {
    const store = new Store(':memory:')
    stores.push(store)
    return store
}

function createPublisher(): EventPublisher {
    return { emit: () => {} } as unknown as EventPublisher
}

function setup(options?: { metadata?: Record<string, unknown>; provider?: { suggest(prompt: string): Promise<string> } }) {
    const store = makeStore()
    const cache = new SessionCache(store, createPublisher())
    const session = cache.getOrCreateSession(
        'automatic-title-test',
        { path: '/workspace/project', host: 'localhost', ...options?.metadata },
        null,
        'default'
    )
    store.messages.addMessage(session.id, {
        role: 'user',
        content: { type: 'text', text: 'Explain the deployment process' }
    })
    store.messages.addMessage(session.id, {
        role: 'assistant',
        content: { type: 'text', text: 'The deployment process has three steps.' }
    })
    const titleService = new TitleSuggestionService(store, {
        provider: options?.provider ?? { suggest: async () => 'Deployment process' }
    })
    const automatic = new AutomaticTitleSuggestionService(cache, titleService, () => 1234)
    return { store, cache, session, titleService, automatic }
}

describe('AutomaticTitleSuggestionService', () => {
    it('generates one summary for an untitled first-turn session', async () => {
        const { cache, session, automatic } = setup()

        await automatic.onTurnCompleted(session.id)

        expect(cache.getSession(session.id)?.metadata).toMatchObject({
            summary: { text: 'Deployment process' },
            titleSuggestionAutoAttemptedAt: 1234
        })
    })

    it('does not overwrite a manual name or existing summary', async () => {
        const manual = setup({ metadata: { name: 'Manual title' } })
        const summary = setup({ metadata: { summary: { text: 'Native title', updatedAt: 100 } } })

        await manual.automatic.onTurnCompleted(manual.session.id)
        await summary.automatic.onTurnCompleted(summary.session.id)

        expect(manual.cache.getSession(manual.session.id)?.metadata?.name).toBe('Manual title')
        expect(manual.cache.getSession(manual.session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
        expect(summary.cache.getSession(summary.session.id)?.metadata?.summary?.text).toBe('Native title')
        expect(summary.cache.getSession(summary.session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
    })

    it('records a failed attempt and does not retry automatically', async () => {
        let calls = 0
        const { cache, session, automatic } = setup({
            provider: {
                suggest: async () => {
                    calls += 1
                    throw new Error('provider failed')
                }
            }
        })

        await automatic.onTurnCompleted(session.id)
        await automatic.onTurnCompleted(session.id)

        expect(calls).toBe(1)
        expect(cache.getSession(session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBe(1234)
        expect(cache.getSession(session.id)?.metadata?.summary).toBeUndefined()
    })

    it('does not reserve an attempt when the provider is not configured', async () => {
        const store = makeStore()
        const cache = new SessionCache(store, createPublisher())
        const session = cache.getOrCreateSession(
            'automatic-title-unconfigured',
            { path: '/workspace/project', host: 'localhost' },
            null,
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'Title this session' }
        })
        store.messages.addMessage(session.id, {
            role: 'assistant',
            content: { type: 'text', text: 'This session is ready.' }
        })
        const automatic = new AutomaticTitleSuggestionService(
            cache,
            new TitleSuggestionService(store),
            () => 1234
        )

        await automatic.onTurnCompleted(session.id)

        expect(cache.getSession(session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
    })

    it('does not auto-generate after the first user turn', async () => {
        let calls = 0
        const { store, session, automatic } = setup({
            provider: { suggest: async () => { calls += 1; return 'Should not be used' } }
        })
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'Now explain the rollback process' }
        })

        await automatic.onTurnCompleted(session.id)

        expect(calls).toBe(0)
        expect(store.sessions.getSession(session.id)?.metadata).not.toHaveProperty('titleSuggestionAutoAttemptedAt')
    })

    it('waits for an assistant response before reserving the fallback attempt', async () => {
        let calls = 0
        const store = makeStore()
        const cache = new SessionCache(store, createPublisher())
        const session = cache.getOrCreateSession(
            'automatic-title-awaits-response',
            { path: '/workspace/project', host: 'localhost' },
            null,
            'default'
        )
        store.messages.addMessage(session.id, {
            role: 'user',
            content: { type: 'text', text: 'Title this session' }
        })
        const automatic = new AutomaticTitleSuggestionService(
            cache,
            new TitleSuggestionService(store, {
                provider: { suggest: async () => { calls += 1; return 'Unexpected title' } }
            }),
            () => 1234
        )

        await automatic.onTurnCompleted(session.id)

        expect(calls).toBe(0)
        expect(cache.getSession(session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
    })

    it('does not overwrite a title that arrives while generation is in flight', async () => {
        let resolveTitle!: (title: string) => void
        const { cache, session, automatic } = setup({
            provider: {
                suggest: async () => await new Promise<string>((resolve) => {
                    resolveTitle = resolve
                })
            }
        })

        const pending = automatic.onTurnCompleted(session.id)
        await Promise.resolve()
        await cache.updateSessionSummary(session.id, 'Native title')
        resolveTitle('Late automatic title')
        await pending

        expect(cache.getSession(session.id)?.metadata?.summary?.text).toBe('Native title')
    })

    it('does not overwrite a manual name that arrives while generation is in flight', async () => {
        let resolveTitle!: (title: string) => void
        const { cache, session, automatic } = setup({
            provider: {
                suggest: async () => await new Promise<string>((resolve) => {
                    resolveTitle = resolve
                })
            }
        })

        const pending = automatic.onTurnCompleted(session.id)
        await Promise.resolve()
        await cache.renameSession(session.id, 'Manual title')
        resolveTitle('Late automatic title')
        await pending

        expect(cache.getSession(session.id)?.metadata?.name).toBe('Manual title')
        expect(cache.getSession(session.id)?.metadata?.summary).toBeUndefined()
    })
})
