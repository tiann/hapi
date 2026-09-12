import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { clearDraft, getDraft } from '@/lib/composer-drafts'
import { encodeBase64 } from '@/lib/utils'
import FilesPage from './files'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    fileSearch: vi.fn(),
    sessionId: 'session-1',
    transferComposerDraftThenNavigate: vi.fn(async (
        _source: string,
        _target: string,
        navigate: () => void | Promise<void>,
    ) => {
        await navigate()
    }),
    sessionHeaderProps: null as null | {
        onSessionReopened?: (newSessionId: string) => void | Promise<void>
    },
    search: {} as { tab?: 'changes' | 'directories'; query?: string },
    gitStatus: {
        status: null as null | Record<string, unknown>,
        error: null as null | string,
        isLoading: false,
        refetch: vi.fn(),
    },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: mocks.sessionId }),
    useSearch: () => mocks.search,
}))

vi.mock('@/lib/composer-draft-transfer', () => ({
    transferComposerDraftThenNavigate: mocks.transferComposerDraftThenNavigate,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: {
            id: mocks.sessionId,
            metadata: { path: '/workspace/project' },
        },
    }),
}))

vi.mock('@/hooks/queries/useGitStatusFiles', () => ({
    useGitStatusFiles: () => mocks.gitStatus,
}))

vi.mock('@/hooks/queries/useSessionFileSearch', () => ({
    useSessionFileSearch: (...args: unknown[]) => {
        mocks.fileSearch(...args)
        return {
            files: [{
                fileName: '感言.ts',
                filePath: 'src',
                fullPath: 'src/感言.ts',
                fileType: 'file' as const,
            }],
            error: null,
            isLoading: false,
            refetch: vi.fn(),
        }
    },
}))

vi.mock('@/components/SessionHeader', () => ({
    SessionHeader: (props: { onSessionReopened?: (newSessionId: string) => void | Promise<void> }) => {
        mocks.sessionHeaderProps = props
        return null
    },
}))

vi.mock('@/components/SessionFiles/DirectoryTree', () => ({
    DirectoryTree: () => null,
}))

function renderFilesPage() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })

    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <FilesPage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

// Most tests do not render git rows; only the changes-row suite installs a status.
beforeEach(() => {
    mocks.gitStatus = { status: null, error: null, isLoading: false, refetch: vi.fn() }
})

describe('FilesPage search navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = { tab: 'directories', query: '感' }
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('restores the route query and carries it through file navigation', () => {
        renderFilesPage()

        const input = screen.getByRole('textbox')
        expect(input).toHaveValue('感')
        const sortButton = screen.getByRole('button', { name: 'Sort files' })
        const refreshButton = screen.getByRole('button', { name: 'Refresh filesystem view' })
        expect(sortButton.parentElement?.parentElement).toBe(input.parentElement)
        expect(input.parentElement?.nextElementSibling).toBe(refreshButton)
        expect(sortButton).toHaveClass('w-10', 'self-stretch')
        expect(refreshButton).toHaveClass('h-9', 'w-9')
        expect(mocks.fileSearch).toHaveBeenCalledWith(
            expect.anything(),
            'session-1',
            '感',
            { enabled: true },
        )

        fireEvent.click(screen.getByRole('button', { name: /感言\.ts/ }))
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64('src/感言.ts'),
                tab: 'directories',
                query: '感',
            },
            resetScroll: false,
        })

        fireEvent.change(input, { target: { value: '言' } })
        expect(mocks.navigate).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-1' },
            search: {
                tab: 'directories',
                query: '言',
            },
            replace: true,
            resetScroll: false,
        })

        fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
        expect(mocks.navigate).toHaveBeenLastCalledWith({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-1' },
            search: { tab: 'directories' },
            replace: true,
            resetScroll: false,
        })
    })
})

describe('FilesPage tab preference', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.sessionHeaderProps = null
        mocks.search = {}
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('restores the globally remembered tab for a different session', () => {
        const firstRender = renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(screen.getByRole('tab', { name: 'Directories' }))
        expect(window.localStorage.getItem('hapi-files-tab')).toBe('directories')
        firstRender.unmount()

        mocks.sessionId = 'session-2'
        renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Directories' })).toHaveAttribute('aria-selected', 'true')
    })

    it('remembers Changes after the user switches back from Directories', () => {
        window.localStorage.setItem('hapi-files-tab', 'directories')
        const firstRender = renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Directories' })).toHaveAttribute('aria-selected', 'true')

        fireEvent.click(screen.getByRole('tab', { name: 'Changes' }))
        expect(window.localStorage.getItem('hapi-files-tab')).toBe('changes')
        firstRender.unmount()

        renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')
    })

    it('uses an explicit route tab before the stored browser preference', () => {
        window.localStorage.setItem('hapi-files-tab', 'directories')
        mocks.search = { tab: 'changes' }

        renderFilesPage()

        expect(screen.getByRole('tab', { name: 'Changes' })).toHaveAttribute('aria-selected', 'true')
        expect(window.localStorage.getItem('hapi-files-tab')).toBe('changes')
    })
})

describe('FilesPage reopen draft transfer', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.sessionHeaderProps = null
        mocks.search = { tab: 'directories', query: '感' }
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('transfers the composer draft before navigating to a reopened files route', async () => {
        renderFilesPage()
        expect(mocks.sessionHeaderProps?.onSessionReopened).toEqual(expect.any(Function))

        await mocks.sessionHeaderProps!.onSessionReopened!('session-reopened')

        expect(mocks.transferComposerDraftThenNavigate).toHaveBeenCalledWith(
            'session-1',
            'session-reopened',
            expect.any(Function),
        )
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/files',
            params: { sessionId: 'session-reopened' },
            replace: true,
            resetScroll: false,
        })
    })

    it('preserves the directory scroll position across route remounts', () => {
        const firstRender = renderFilesPage()
        const firstScrollRegion = document.querySelector('[data-hapi-session-files-scroll="true"]') as HTMLElement
        firstScrollRegion.scrollTop = 87
        firstRender.unmount()

        renderFilesPage()
        const secondScrollRegion = document.querySelector('[data-hapi-session-files-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(87)
    })
})

describe('FilesPage file context menu', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = { tab: 'directories', query: '感' }
        window.localStorage.clear()
        window.sessionStorage.clear()
        clearDraft('session-1')
    })

    it('adds a file to the composer draft and navigates back to the chat', () => {
        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to composer' }))

        expect(getDraft('session-1')).toBe('`src/感言.ts`')
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
            resetScroll: false,
        })
    })

    it('copies the absolute path resolved from the session workspace', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        renderFilesPage()

        fireEvent.contextMenu(screen.getByRole('button', { name: /感言\.ts/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy absolute path' }))

        await vi.waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('/workspace/project/src/感言.ts')
        })
    })
})

describe('FilesPage changes-row context menu', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionId = 'session-1'
        mocks.search = {}
        mocks.gitStatus = {
            status: {
                stagedFiles: [],
                unstagedFiles: [{
                    fileName: 'README.md',
                    filePath: '',
                    fullPath: 'README.md',
                    status: 'modified',
                    isStaged: false,
                    linesAdded: 2,
                    linesRemoved: 1,
                }],
                branch: 'main',
                totalStaged: 0,
                totalUnstaged: 1,
            },
            error: null,
            isLoading: false,
            refetch: vi.fn(),
        }
        window.localStorage.clear()
        window.sessionStorage.clear()
        clearDraft('session-1')
    })

    it('opens the menu on a git change row and adds it to the composer', () => {
        renderFilesPage()

        fireEvent.contextMenu(screen.getByText('README.md').closest('button')!)
        fireEvent.click(screen.getByRole('menuitem', { name: 'Add to composer' }))

        expect(getDraft('session-1')).toBe('`README.md`')
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
            resetScroll: false,
        })
    })

    it('copies the absolute path for a git change row', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        })

        renderFilesPage()

        fireEvent.contextMenu(screen.getByText('README.md').closest('button')!)
        fireEvent.click(screen.getByRole('menuitem', { name: 'Copy absolute path' }))

        await vi.waitFor(() => {
            expect(writeText).toHaveBeenCalledWith('/workspace/project/README.md')
        })
    })

    it('opens the menu on touch long-press and does not navigate on release', () => {
        vi.useFakeTimers()
        try {
            renderFilesPage()
            const row = screen.getByText('README.md').closest('button')!

            fireEvent.touchStart(row, { touches: [{ clientX: 120, clientY: 240 }] })
            act(() => {
                vi.advanceTimersByTime(600)
            })
            expect(screen.getByRole('menuitem', { name: 'Copy path' })).toBeInTheDocument()

            fireEvent.touchEnd(row, { changedTouches: [{ clientX: 120, clientY: 240 }] })
            expect(mocks.navigate).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })
})
