import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
import { ApiError } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { formatFileMetadata } from '@/lib/file-metadata'
import { encodeBase64 } from '@/lib/utils'
import FilePage from './file'

const goBackMock = vi.fn()
const copyMock = vi.hoisted(() => vi.fn())
const reopenSessionMock = vi.hoisted(() => vi.fn())
const readSessionFileMock = vi.hoisted(() => vi.fn())
const getGitDiffFileMock = vi.hoisted(() => vi.fn())

const sampleMarkdown = '# Heading\n\n| Col A | Col B |\n| --- | --- |\n| one | two |'
const filePath = 'docs/README.md'
const encodedPath = encodeBase64(filePath)
const encodedContent = encodeBase64(sampleMarkdown)
const fileSize = 1024
const fileModified = 1_784_175_060_000

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => ({
        path: encodedPath,
        staged: undefined,
    }),
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: {
            id: 'session-1',
            active: false,
            metadata: {
                path: '/project',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-1',
            },
        },
        isLoading: false,
        error: null,
        notFound: false,
        refetch: vi.fn(),
    }),
}))

vi.mock('@/hooks/queries/useCursorChatStoreStatus', () => ({
    useCursorChatStoreStatus: () => ({
        status: { onDisk: true },
        error: null,
        isLoading: false,
    }),
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        reopenSession: reopenSessionMock,
        isPending: false,
    }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {
            getGitDiffFile: getGitDiffFileMock,
            readSessionFile: readSessionFileMock,
        },
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => goBackMock,
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: copyMock,
    }),
}))

vi.mock('@/lib/shiki', () => ({
    langAlias: { md: 'markdown' },
    useShikiHighlighter: (content: string) => content,
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => (
        <div data-testid="markdown-preview">{props.content}</div>
    ),
}))

function renderWithProviders() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <FilePage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('FilePage markdown preview', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        window.sessionStorage.clear()
        getGitDiffFileMock.mockResolvedValue({ success: true, stdout: '' })
        readSessionFileMock.mockResolvedValue({
            success: true,
            content: encodedContent,
            size: fileSize,
            modified: fileModified,
        })
        reopenSessionMock.mockResolvedValue({ ok: true, sessionId: 'session-1', resumed: true })
    })

    it('renders markdown preview by default and toggles to source', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Heading')
        })
        expect(screen.getByText(formatFileMetadata(fileSize, fileModified, 'en')!)).toBeInTheDocument()
        expect(screen.getAllByText(filePath)).toHaveLength(1)
        const previewCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(previewCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(previewCopyButton).not.toHaveClass('absolute')
        fireEvent.click(previewCopyButton)
        expect(copyMock).toHaveBeenCalledWith(sampleMarkdown)
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('opacity-80')

        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourcePreview = screen.getByRole('code').closest('[data-hapi-file-source-preview="true"]')
        const sourceCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(sourcePreview).not.toBeNull()
        expect(sourcePreview).toContainElement(sourceCopyButton)
        expect(sourceCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(sourceCopyButton).not.toHaveClass('absolute')
        expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
    })

    it('preserves the file preview scroll position across route remounts', async () => {
        const firstRender = renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const firstScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(firstScrollRegion).not.toBeNull()
        firstScrollRegion.scrollTop = 123
        firstRender.unmount()

        renderWithProviders()
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const secondScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(123)
    })
})

describe('FilePage offline session', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        window.sessionStorage.clear()
        const rpcError = new ApiError(
            'HTTP 503: rpc target missing',
            503,
            RPC_TARGET_MISSING_ERROR_CODE,
            JSON.stringify({ success: false, code: RPC_TARGET_MISSING_ERROR_CODE })
        )
        getGitDiffFileMock.mockRejectedValue(rpcError)
        readSessionFileMock.mockRejectedValue(rpcError)
        reopenSessionMock.mockResolvedValue({ ok: true, sessionId: 'session-1', resumed: true })
    })

    it('shows friendly offline copy and reopen affordance instead of raw RPC errors', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByText(/not connected to your computer right now/i)).toBeInTheDocument()
        })
        expect(screen.queryByText(/RPC handler not registered/i)).toBeNull()
        expect(screen.getByRole('button', { name: 'Reopen session' })).toBeInTheDocument()
    })

    it('refetches file queries after reopen succeeds', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Reopen session' })).toBeInTheDocument()
        })

        readSessionFileMock.mockResolvedValue({
            success: true,
            content: encodedContent,
            size: fileSize,
            modified: fileModified,
        })
        getGitDiffFileMock.mockResolvedValue({ success: true, stdout: '' })

        fireEvent.click(screen.getByRole('button', { name: 'Reopen session' }))

        await waitFor(() => {
            expect(reopenSessionMock).toHaveBeenCalled()
            expect(readSessionFileMock).toHaveBeenCalledTimes(2)
        })
    })
})
