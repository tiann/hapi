import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routerMocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    historyBack: vi.fn(),
    pathname: '/sessions',
    search: {} as unknown,
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => routerMocks.navigate,
    useRouter: () => ({ history: { back: routerMocks.historyBack } }),
    useLocation: ({ select }: {
        select: (location: { pathname: string; search: unknown }) => unknown
    }) => select({ pathname: routerMocks.pathname, search: routerMocks.search }),
}))

import { getSessionFilesBackSearch, getSettingsBackTarget, useAppGoBack } from './useAppGoBack'

beforeEach(() => {
    routerMocks.navigate.mockReset()
    routerMocks.historyBack.mockReset()
    routerMocks.pathname = '/sessions'
    routerMocks.search = {}
})

describe('getSettingsBackTarget', () => {
    it.each([
        ['/settings', '/sessions'],
        ['/settings/general', '/settings'],
        ['/settings/display', '/settings'],
        ['/settings/voice', '/settings'],
        ['/settings/voice/voices', '/settings/voice'],
        ['/settings/voice/advanced', '/settings/voice'],
        ['/sessions', null],
    ])('maps %s to %s', (pathname, target) => {
        expect(getSettingsBackTarget(pathname)).toBe(target)
    })
})

describe('getSessionFilesBackSearch', () => {
    it('preserves the directory tab and file search query', () => {
        expect(getSessionFilesBackSearch({
            path: 'encoded-path',
            staged: false,
            tab: 'directories',
            query: '感',
        })).toEqual({
            tab: 'directories',
            query: '感',
        })
    })

    it('drops unrelated and invalid search values', () => {
        expect(getSessionFilesBackSearch({
            path: 'encoded-path',
            tab: 'changes',
            query: '',
        })).toEqual({})
        expect(getSessionFilesBackSearch(null)).toEqual({})
    })
})

describe('useAppGoBack file preview navigation', () => {
    it('returns directly to chat when the preview was opened from a chat link', () => {
        routerMocks.pathname = '/sessions/session-1/file'
        routerMocks.search = { path: 'encoded-path', origin: 'chat' }
        const { result } = renderHook(() => useAppGoBack())

        act(() => result.current())

        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/session-1',
            resetScroll: false,
        })
    })

    it('keeps returning file-browser previews to their previous file context', () => {
        routerMocks.pathname = '/sessions/session-1/file'
        routerMocks.search = {
            path: 'encoded-path',
            tab: 'directories',
            query: 'readme',
        }
        const { result } = renderHook(() => useAppGoBack())

        act(() => result.current())

        expect(routerMocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/session-1/files',
            search: {
                tab: 'directories',
                query: 'readme',
            },
            resetScroll: false,
        })
    })
})
