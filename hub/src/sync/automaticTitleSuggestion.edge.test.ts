import { afterEach, describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SessionCache } from './sessionCache'
import { AutomaticTitleSuggestionService } from './automaticTitleSuggestion'
import { TitleSuggestionService } from './titleSuggestion'
import type { EventPublisher } from './eventPublisher'

const stores: Store[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup(provider = { suggest: async (_prompt: string) => 'Fallback title' }) {
    const store = new Store(':memory:')
    stores.push(store)
    const cache = new SessionCache(store, { emit() {} } as unknown as EventPublisher)
    const session = cache.getOrCreateSession('edge-case', { path: '/project', host: 'test' }, null, 'tenant')
    const service = new TitleSuggestionService(store, { provider })
    const automatic = new AutomaticTitleSuggestionService(cache, service, () => 1000)
    const add = (role: string, text: string, queued = false) => store.messages.addMessage(session.id,
        { role, content: { type: 'text', text } }, queued ? 'queued-id' : undefined)
    return { store, cache, session, service, automatic, add }
}

function deferred() {
    let resolve!: (value: string) => void
    const promise = new Promise<string>(r => { resolve = r })
    return { promise, resolve }
}

describe('automatic title safety and first-turn eligibility', () => {
    it('uses the observed first turn for steering when completion has no ready record', async () => {
        const h = setup()
        h.automatic.onTurnStarted(h.session.id)
        h.add('user', 'Initial task'); h.add('assistant', 'Partial output')
        h.add('user', 'Steering prompt'); h.add('assistant', 'Final output')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('does not treat an observed later turn without ready records as the first', async () => {
        const h = setup()
        h.add('user', 'Old task'); h.add('assistant', 'Old answer')
        h.automatic.onTurnStarted(h.session.id)
        h.add('user', 'Current task'); h.add('assistant', 'Current answer')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary).toBeUndefined()
        expect(h.cache.getSession(h.session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
    })

    it('allows the first answered turn after an earlier empty completion', async () => {
        const h = setup()
        h.automatic.onTurnStarted(h.session.id)
        h.add('user', 'Unanswered task')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.titleSuggestionAutoAttemptedAt).toBeUndefined()
        h.automatic.onTurnStarted(h.session.id)
        h.add('user', 'Try again'); h.add('assistant', 'First answer')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('treats batched initial prompts as one completed turn', async () => {
        const h = setup()
        h.add('user', 'Explain deployment')
        h.add('user', 'Include rollback')
        h.add('assistant', 'Deployment and rollback explained')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('includes prompts steered after partial output before the first ready boundary', async () => {
        const h = setup()
        h.add('user', 'Explain deployment')
        h.add('assistant', 'Checking the workflow')
        h.add('user', 'Also include rollback')
        h.add('assistant', 'Deployment and rollback explained')
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('does not count a second consumed prompt after an earlier ready as the first turn', () => {
        const h = setup()
        h.add('user', 'First task')
        h.add('assistant', 'First answer')
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        h.add('user', 'Second task')
        h.add('assistant', 'Second answer')
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(false)
    })

    it('finds a previous ready boundary beyond the provider message window', () => {
        const h = setup()
        h.add('user', 'First task'); h.add('assistant', 'First answer')
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        h.add('user', 'Second task')
        for (let i = 0; i < 205; i++) h.store.messages.addMessage(h.session.id,
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } })
        h.add('assistant', 'Second answer')
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: { type: 'event', data: { type: 'ready' } } })
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(false)
    })

    it('coalesces overlapping completion events into one provider request', async () => {
        const pending = deferred()
        let calls = 0
        const h = setup({ suggest: async () => { calls++; return pending.promise } })
        h.add('user', 'Explain deployment'); h.add('assistant', 'Deployment explained')
        const first = h.automatic.onTurnCompleted(h.session.id)
        await Promise.resolve()
        await h.automatic.onTurnCompleted(h.session.id)
        expect(calls).toBe(1)
        pending.resolve('Deployment')
        await first
        await h.automatic.onTurnCompleted(h.session.id)
        expect(calls).toBe(1)
    })

    it('preserves the attempt across service/cache recreation after provider failure', async () => {
        let calls = 0
        const provider = { suggest: async () => { calls++; throw new Error('offline') } }
        const h = setup(provider)
        h.add('user', 'Explain deployment'); h.add('assistant', 'Deployment explained')
        await h.automatic.onTurnCompleted(h.session.id)
        const cache = new SessionCache(h.store, { emit() {} } as unknown as EventPublisher)
        cache.refreshSession(h.session.id)
        const restarted = new AutomaticTitleSuggestionService(cache, new TitleSuggestionService(h.store, { provider }))
        await restarted.onTurnCompleted(h.session.id)
        expect(calls).toBe(1)
    })

    it('retains manual Generate after an automatic failure', async () => {
        let calls = 0
        const h = setup({ suggest: async () => { if (++calls === 1) throw new Error('offline'); return 'Manual retry' } })
        h.add('user', 'Explain deployment'); h.add('assistant', 'Deployment explained')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(await h.service.suggestTitle(h.session.id)).toBe('Manual retry')
        expect(calls).toBe(2)
    })

    it('does not apply a provider result after the session is deleted', async () => {
        const pending = deferred()
        const h = setup({ suggest: async () => pending.promise })
        h.add('user', 'Explain deployment'); h.add('assistant', 'Deployment explained')
        const work = h.automatic.onTurnCompleted(h.session.id)
        await Promise.resolve()
        h.store.sessions.deleteSession(h.session.id, 'tenant')
        pending.resolve('Deleted title')
        await work
        expect(h.store.sessions.getSession(h.session.id)).toBeNull()
    })

    it('does not write a pending result or begin more requests after stop', async () => {
        const pending = deferred()
        let calls = 0
        const h = setup({ suggest: async () => { calls++; return pending.promise } })
        h.add('user', 'Explain deployment'); h.add('assistant', 'Deployment explained')
        const work = h.automatic.onTurnCompleted(h.session.id)
        await Promise.resolve()
        h.automatic.stop()
        pending.resolve('Stopped title')
        await work
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary).toBeUndefined()
        expect(calls).toBe(1)
    })

    it('accepts whitespace-only existing title fields without changing session recency', async () => {
        const h = setup()
        await h.cache.renameSession(h.session.id, '   ')
        await h.cache.updateSessionSummary(h.session.id, '  ')
        const before = h.store.sessions.getSession(h.session.id)!.updatedAt
        h.add('user', 'Explain deployment'); h.add('assistant', 'Deployment explained')
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
        expect(h.cache.getSession(h.session.id)?.metadata?.name).toBeUndefined()
        expect(h.store.sessions.getSession(h.session.id)!.updatedAt).toBe(before)
    })

    it('ignores queued follow-up messages when identifying the completed first turn', async () => {
        const h = setup()
        h.add('user', 'First task'); h.add('assistant', 'First answer'); h.add('user', 'Queued follow-up', true)
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(true)
        await h.automatic.onTurnCompleted(h.session.id)
        expect(h.cache.getSession(h.session.id)?.metadata?.summary?.text).toBe('Fallback title')
    })

    it('does not mistake assistant output preceding the first user message for its answer', () => {
        const h = setup()
        h.add('assistant', 'Welcome'); h.add('user', 'First task')
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(false)
    })

    it('finds the first user turn beyond a full window of tool output', () => {
        const h = setup()
        h.add('user', 'Long first task')
        for (let i = 0; i < 205; i++) h.store.messages.addMessage(h.session.id,
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } })
        h.add('assistant', 'Final answer')
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(true)
    })

    it('does not mistake the most recent turn of a long history for its first turn', () => {
        const h = setup()
        h.add('user', 'Old task'); h.add('assistant', 'Old answer')
        for (let i = 0; i < 205; i++) h.store.messages.addMessage(h.session.id,
            { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', name: 'shell', input: {} } } })
        h.add('user', 'New task'); h.add('assistant', 'New answer')
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(false)
    })

    it('does not count tool results or reasoning as a visible first answer', () => {
        const h = setup()
        h.add('user', 'First task')
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: {
            type: 'codex', data: { type: 'tool-call-result', output: 'internal result' }
        } })
        h.store.messages.addMessage(h.session.id, { role: 'agent', content: {
            type: 'codex', data: { type: 'reasoning', message: 'internal thought' }
        } })
        expect(h.service.hasCompletedFirstTurn(h.session.id)).toBe(false)
    })
})
