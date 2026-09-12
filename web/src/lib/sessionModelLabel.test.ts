import { describe, expect, it } from 'vitest'
import { getSessionAgentLabel, getSessionModelLabel } from './sessionModelLabel'

describe('getSessionAgentLabel', () => {
    it('renders the shared display label for known agent flavors', () => {
        expect(getSessionAgentLabel({ metadata: { flavor: 'codex' } })).toBe('Codex')
        expect(getSessionAgentLabel({ metadata: { flavor: 'opencode' } })).toBe('OpenCode')
    })

    it('preserves unknown agent flavors', () => {
        expect(getSessionAgentLabel({ metadata: { flavor: 'some-new-cli' } })).toBe('some-new-cli')
    })

    it('falls back when the session has no agent flavor', () => {
        expect(getSessionAgentLabel({})).toBe('unknown')
    })
})

describe('getSessionModelLabel', () => {
    it('prefers the explicit session model', () => {
        expect(getSessionModelLabel({ model: 'gpt-5.4' })).toEqual({
            key: 'session.item.model',
            value: 'gpt-5.4'
        })
    })

    it('renders friendly labels for known Claude aliases', () => {
        expect(getSessionModelLabel({ model: 'opus' })).toEqual({
            key: 'session.item.model',
            value: 'Opus'
        })
    })

    it('uses the model catalog display name when available', () => {
        expect(getSessionModelLabel({ model: 'gpt-5.6-sol' }, 'GPT-5.6-Sol')).toEqual({
            key: 'session.item.model',
            value: 'GPT-5.6-Sol'
        })
    })

    it('formats a Codex model id when the catalog is unavailable', () => {
        expect(getSessionModelLabel({
            model: 'gpt-5.6-sol',
            metadata: { flavor: 'codex' }
        })).toEqual({
            key: 'session.item.model',
            value: 'GPT-5.6-Sol'
        })
    })

    it('preserves unknown Codex model ids', () => {
        expect(getSessionModelLabel({
            model: 'o3-mini',
            metadata: { flavor: 'codex' }
        })?.value).toBe('o3-mini')
    })

    it('returns null when no model is available', () => {
        expect(getSessionModelLabel({})).toBeNull()
    })
})
