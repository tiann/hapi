import { describe, expect, it } from 'vitest'
import { getSessionTitle } from './sessionTitle'

describe('sessionTitle lib', () => {
    describe('getSessionTitle', () => {
        it('returns metadata name when available', () => {
            const session = {
                id: 'session-123',
                metadata: { name: 'My Session' },
            } as const
            expect(getSessionTitle(session as any)).toBe('My Session')
        })

        it('returns summary text when name is not available', () => {
            const session = {
                id: 'session-123',
                metadata: { summary: { text: 'Summary Text' } },
            } as const
            expect(getSessionTitle(session as any)).toBe('Summary Text')
        })

        it('returns last path segment when path is available', () => {
            const session = {
                id: 'session-123',
                metadata: { path: '/home/user/project' },
            }
            expect(getSessionTitle(session)).toBe('project')
        })

        it('handles path with trailing slash', () => {
            const session = {
                id: 'session-123',
                metadata: { path: '/home/user/project/' },
            }
            expect(getSessionTitle(session)).toBe('project')
        })

        it('returns first 8 chars of ID when no metadata', () => {
            const session = {
                id: 'session-123456789',
                metadata: {},
            } as const
            expect(getSessionTitle(session as any)).toBe('session-')
        })

        it('returns first 8 chars of ID when metadata is null', () => {
            const session = {
                id: 'abcdefghijklmnop',
                metadata: null,
            }
            expect(getSessionTitle(session)).toBe('abcdefgh')
        })

        it('prioritizes name over summary', () => {
            const session = {
                id: 'session-123',
                metadata: {
                    name: 'My Name',
                    summary: { text: 'My Summary' },
                },
            } as const
            expect(getSessionTitle(session as any)).toBe('My Name')
        })

        it('prioritizes name over path', () => {
            const session = {
                id: 'session-123',
                metadata: {
                    name: 'My Name',
                    path: '/home/user/project',
                },
            }
            expect(getSessionTitle(session)).toBe('My Name')
        })

        it('prioritizes summary over path', () => {
            const session = {
                id: 'session-123',
                metadata: {
                    summary: { text: 'My Summary' },
                    path: '/home/user/project',
                },
            }
            expect(getSessionTitle(session)).toBe('My Summary')
        })
    })
})
