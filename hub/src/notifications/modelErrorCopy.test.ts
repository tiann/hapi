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

    it('truncates raw excerpt when oversized', () => {
        const longRaw = 'A'.repeat(500)
        const body = formatModelErrorBody(
            baseNotification({ rawSnippet: longRaw }),
            ctx
        )
        const lines = body.split('\n')
        const excerptLine = lines.find((l) => l.startsWith('A'))
        expect(excerptLine).toBeDefined()
        expect(excerptLine?.endsWith('...')).toBe(true)
        expect(excerptLine?.length).toBeLessThanOrEqual(140)
    })

    it('collapses internal whitespace in the excerpt', () => {
        const body = formatModelErrorBody(
            baseNotification({ rawSnippet: 'line 1\n\n  line 2\n\tline 3' }),
            ctx
        )
        expect(body).toContain('line 1 line 2 line 3')
    })

    it('omits the excerpt line when raw is empty/whitespace-only', () => {
        const body = formatModelErrorBody(
            baseNotification({ rawSnippet: '   \n\n   ' }),
            ctx
        )
        expect(body).toContain('Cursor - feature-x')
        const lines = body.split('\n')
        // Lines: agent/session line; no whitespace-only line; no transient
        // (false). Should be exactly one line in this case.
        expect(lines).toHaveLength(1)
    })
})
