import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'
import FilesPage from './files'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    fileSearch: vi.fn(),
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
    search: {
        tab: 'directories' as const,
        query: '感',
    },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: 'session-1' }),
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
            id: 'session-1',
            metadata: { path: '/workspace/project' },
        },
    }),
}))

vi.mock('@/hooks/queries/useGitStatusFiles', () => ({
    useGitStatusFiles: () => ({
        status: null,
        error: null,
        isLoading: false,
        refetch: vi.fn(),
    }),
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

describe('FilesPage search navigation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
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

describe('FilesPage reopen draft transfer', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.sessionHeaderProps = null
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
