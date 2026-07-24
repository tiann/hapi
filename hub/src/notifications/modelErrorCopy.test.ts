import { describe, expect, it } from 'bun:test'
import type { ModelErrorNotification } from './notificationTypes'
import { formatModelErrorBody, formatModelErrorTitle } from './modelErrorCopy'

const baseNotification = (overrides: Partial<ModelErrorNotification> = {}): ModelErrorNotification => ({
    kind: 'quota_exhausted',
    transient: false,
    rawSnippet: 'Error: T: [resource_exhausted] capacity exceeded for the day',
    priorAssistantClaimsDone: false,
    atTs: 1700000000000,
    ...overrides
})

describe('formatModelErrorTitle', () => {
    it('returns kind-specific titles for known kinds', () => {
        expect(formatModelErrorTitle('quota_exhausted')).toBe('Quota exhausted')
        expect(formatModelErrorTitle('rate_limited')).toBe('Rate limited')
        expect(formatModelErrorTitle('transport_closed')).toBe('Agent transport closed')
        expect(formatModelErrorTitle('agent_crashed')).toBe('Agent crashed')
        expect(formatModelErrorTitle('rpc_timeout')).toBe('Agent request timed out')
        expect(formatModelErrorTitle('context_window')).toBe('Context window exceeded')
    })

    it('falls back to generic Model error for unknown kinds', () => {
        expect(formatModelErrorTitle('unknown_t_prefix')).toBe('Model error')
        expect(formatModelErrorTitle('unknown_stderr')).toBe('Model error')
        expect(formatModelErrorTitle('something_we_have_not_seen')).toBe('Model error')
    })
})

describe('formatModelErrorBody', () => {
    const ctx = { agentName: 'Cursor', sessionName: 'feature-x' }

    it('leads with the lying-completion warning when priorAssistantClaimsDone', () => {
        const body = formatModelErrorBody(
            baseNotification({ priorAssistantClaimsDone: true }),
            ctx
        )
        const firstLine = body.split('\n')[0]
        expect(firstLine).toContain('claimed completion')
        expect(firstLine).toContain('INCOMPLETE')
    })

    it('omits the warning line when prior claim is false', () => {
        const body = formatModelErrorBody(
            baseNotification({ priorAssistantClaimsDone: false }),
            ctx
        )
        expect(body).not.toContain('claimed completion')
        expect(body).toContain('Cursor - feature-x')
    })

    it('appends the transient hint when transient', () => {
        const body = formatModelErrorBody(
            baseNotification({ transient: true }),
            ctx
        )
        expect(body).toContain('(transient - safe to retry)')
    })

    it('omits the transient hint when not transient', () => {
        const body = formatModelErrorBody(
            baseNotification({ transient: false }),
            ctx
        )
        expect(body).not.toContain('transient')
    })

    it('omits rawSnippet from external notification bodies', () => {
        const secretish = 'Error: T: [auth_failed] Bearer sk-live-DO-NOT-LEAK path=/home/op/.secrets'
        const body = formatModelErrorBody(
            baseNotification({ rawSnippet: secretish }),
            ctx
        )
        expect(body).not.toContain(secretish)
        expect(body).not.toContain('sk-live')
        expect(body).not.toContain('resource_exhausted')
        expect(body).toContain('Cursor - feature-x')
    })

    it('still omits raw even when it is long or multiline', () => {
        const body = formatModelErrorBody(
            baseNotification({ rawSnippet: `line 1\n\n  ${'A'.repeat(500)}` }),
            ctx
        )
        expect(body).not.toContain('AAAA')
        expect(body).not.toContain('line 1')
        expect(body.split('\n')).toEqual(['Cursor - feature-x'])
    })
})
