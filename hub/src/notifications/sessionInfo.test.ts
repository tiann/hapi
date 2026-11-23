import { describe, expect, it } from 'bun:test'
import type { Session } from '../sync/syncEngine'
import { getSessionName } from './sessionInfo'

describe('notification session names', () => {
    it.each([
        ['/work/project\\notes', 'linux', 'project\\notes'],
        ['C:\\work\\notes', undefined, 'notes'],
        ['\\\\host\\share\\notes', undefined, 'notes'],
        ['work\\notes', 'win32', 'notes'],
        ['/work/project\\notes', undefined, 'project\\notes'],
    ])('uses the session OS, not the Hub OS (%s)', (path, os, expected) => {
        expect(getSessionName({ id: 'fixture', metadata: { path, os } } as Session)).toBe(expected)
    })
})
