import { describe, expect, it } from 'vitest'
import { getScrollRestorationKey } from './scrollRestorationKey'
import type { ParsedLocation } from '@tanstack/react-router'

function makeLocation(overrides: Partial<ParsedLocation>): ParsedLocation {
    return {
        pathname: '/',
        search: {},
        searchStr: '',
        hash: '',
        href: '/',
        state: {},
        ...overrides,
    } as ParsedLocation
}

describe('getScrollRestorationKey', () => {
    it('returns pathname for routes without per-query identity', () => {
        expect(getScrollRestorationKey(makeLocation({ pathname: '/sessions' }))).toBe('/sessions')
        expect(getScrollRestorationKey(makeLocation({ pathname: '/sessions/abc123' }))).toBe('/sessions/abc123')
        expect(getScrollRestorationKey(makeLocation({ pathname: '/sessions/abc123/terminal' }))).toBe('/sessions/abc123/terminal')
        expect(getScrollRestorationKey(makeLocation({ pathname: '/settings' }))).toBe('/settings')
        expect(getScrollRestorationKey(makeLocation({ pathname: '/browse' }))).toBe('/browse')
    })

    it('differentiates file routes by the path search param', () => {
        const fileA = makeLocation({
            pathname: '/sessions/abc123/file',
            search: { path: 'src/foo.ts' },
        })
        const fileB = makeLocation({
            pathname: '/sessions/abc123/file',
            search: { path: 'src/bar.ts' },
        })
        expect(getScrollRestorationKey(fileA)).toBe('/sessions/abc123/file?path=src/foo.ts')
        expect(getScrollRestorationKey(fileB)).toBe('/sessions/abc123/file?path=src/bar.ts')
        expect(getScrollRestorationKey(fileA)).not.toBe(getScrollRestorationKey(fileB))
    })

    it('falls back to pathname when file route has no path search param', () => {
        const location = makeLocation({
            pathname: '/sessions/abc123/file',
            search: {},
        })
        expect(getScrollRestorationKey(location)).toBe('/sessions/abc123/file')
    })

    it('differentiates staged vs unstaged file diffs for the same path', () => {
        const unstaged = makeLocation({
            pathname: '/sessions/abc123/file',
            search: { path: 'src/foo.ts' },
        })
        const staged = makeLocation({
            pathname: '/sessions/abc123/file',
            search: { path: 'src/foo.ts', staged: true },
        })
        const stagedFalse = makeLocation({
            pathname: '/sessions/abc123/file',
            search: { path: 'src/foo.ts', staged: false },
        })
        expect(getScrollRestorationKey(unstaged)).toBe('/sessions/abc123/file?path=src/foo.ts')
        expect(getScrollRestorationKey(staged)).toBe('/sessions/abc123/file?path=src/foo.ts&staged=true')
        // staged=false is the default and not included in the key (matches unstaged)
        expect(getScrollRestorationKey(stagedFalse)).toBe('/sessions/abc123/file?path=src/foo.ts')
        expect(getScrollRestorationKey(unstaged)).not.toBe(getScrollRestorationKey(staged))
    })

    it('differentiates browse route by machineId', () => {
        const noMachine = makeLocation({ pathname: '/browse', search: {} })
        const machineA = makeLocation({ pathname: '/browse', search: { machineId: 'm-aaa' } })
        const machineB = makeLocation({ pathname: '/browse', search: { machineId: 'm-bbb' } })
        expect(getScrollRestorationKey(noMachine)).toBe('/browse')
        expect(getScrollRestorationKey(machineA)).toBe('/browse?machineId=m-aaa')
        expect(getScrollRestorationKey(machineB)).toBe('/browse?machineId=m-bbb')
        expect(getScrollRestorationKey(machineA)).not.toBe(getScrollRestorationKey(machineB))
    })

    it('differentiates files route by directories tab', () => {
        const changes = makeLocation({
            pathname: '/sessions/abc123/files',
            search: { tab: 'changes' },
        })
        const directories = makeLocation({
            pathname: '/sessions/abc123/files',
            search: { tab: 'directories' },
        })
        expect(getScrollRestorationKey(changes)).toBe('/sessions/abc123/files')
        expect(getScrollRestorationKey(directories)).toBe('/sessions/abc123/files?tab=directories')
        expect(getScrollRestorationKey(changes)).not.toBe(getScrollRestorationKey(directories))
    })

    it('ignores history-entry-unique state.__TSR_key — same logical key for two history entries', () => {
        const location1 = makeLocation({
            pathname: '/sessions/abc123',
            state: { __TSR_key: 'key_entry_1', __TSR_index: 0 },
        })
        const location2 = makeLocation({
            pathname: '/sessions/abc123',
            state: { __TSR_key: 'key_entry_2', __TSR_index: 1 },
        })
        expect(getScrollRestorationKey(location1)).toBe(getScrollRestorationKey(location2))
    })

    it('ignores hash', () => {
        const location = makeLocation({
            pathname: '/browse',
            hash: '#section-2',
        })
        expect(getScrollRestorationKey(location)).toBe('/browse')
    })
})
