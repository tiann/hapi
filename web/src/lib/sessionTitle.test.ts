import { describe, expect, it } from 'vitest'
import { getSessionTitle } from './sessionTitle'

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
