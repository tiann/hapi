import { describe, expect, it } from 'vitest'
import { getSessionTitle, hasSessionTitleSignal } from './sessionTitle'

describe('getSessionTitle', () => {
    it('prefers metadata.name over summary.text (sidebar / share picker parity)', () => {
        expect(getSessionTitle({
            id: 'abcdef0123456789',
            metadata: {
                name: 'hub runner version governance',
                summary: { text: 'HAPI Skill Lookup' },
                path: '/tmp/share-title-parity',
            },
        })).toBe('hub runner version governance')
    })

    it('falls back to summary when name is absent', () => {
        expect(getSessionTitle({
            id: 'abcdef0123456789',
            metadata: {
                summary: { text: 'HAPI Skill Lookup' },
                path: '/tmp/share-title-parity',
            },
        })).toBe('HAPI Skill Lookup')
    })

    it('uses the prompt title until a name or summary exists', () => {
        expect(getSessionTitle({
            id: 'abcdef0123456789',
            metadata: {
                promptTitle: 'Fix the login redirect',
                path: '/tmp/share-title-parity',
            },
        })).toBe('Fix the login redirect')
        expect(getSessionTitle({
            id: 'abcdef0123456789',
            metadata: {
                summary: { text: 'Login redirect fix' },
                promptTitle: 'Fix the login redirect',
                path: '/tmp/share-title-parity',
            },
        })).toBe('Login redirect fix')
    })

    it('falls back to the last path segment when name and summary are absent', () => {
        expect(getSessionTitle({
            id: 'abcdef0123456789',
            metadata: {
                path: '/tmp/share-title-parity',
            },
        })).toBe('share-title-parity')
    })

    it('falls back to a short id when metadata is empty', () => {
        expect(getSessionTitle({ id: 'abcdef0123456789' })).toBe('abcdef01')
    })
})

describe('hasSessionTitleSignal', () => {
    it('is true for name, summary or prompt title text and false for path-only', () => {
        expect(hasSessionTitleSignal({
            id: 'x',
            metadata: { name: 'Named', path: '/tmp/foo' },
        })).toBe(true)
        expect(hasSessionTitleSignal({
            id: 'x',
            metadata: { summary: { text: 'Summary only' }, path: '/tmp/foo' },
        })).toBe(true)
        expect(hasSessionTitleSignal({
            id: 'x',
            metadata: { promptTitle: 'Prompt only', path: '/tmp/foo' },
        })).toBe(true)
        expect(hasSessionTitleSignal({
            id: 'x',
            metadata: { path: '/tmp/foo' },
        })).toBe(false)
        expect(hasSessionTitleSignal({ id: 'x' })).toBe(false)
    })
})
