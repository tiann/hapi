import { StrictMode } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SharePage from './index'

const navigateMock = vi.fn()
const searchMock = vi.fn<() => Record<string, string | undefined>>(() => ({}))
const putShareTransferMock = vi.fn()
const getShareTransferMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => navigateMock,
    useSearch: () => searchMock(),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: {} }),
}))

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => ({ sessions: [], isLoading: false }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/shareTransfer', async () => {
    const actual = await vi.importActual<typeof import('@/lib/shareTransfer')>('@/lib/shareTransfer')
    return {
        ...actual,
        putShareTransfer: (...args: unknown[]) => putShareTransferMock(...args),
        getShareTransfer: (...args: unknown[]) => getShareTransferMock(...args),
        deleteShareTransfer: vi.fn(),
    }
})

function setShareHash(hash: string): void {
    const path = `/share${hash ? (hash.startsWith('#') ? hash : `#${hash}`) : ''}`
    window.history.replaceState(null, '', path)
}

describe('SharePage', () => {
    beforeEach(() => {
        navigateMock.mockReset()
        searchMock.mockReset()
        searchMock.mockReturnValue({})
        putShareTransferMock.mockReset()
        getShareTransferMock.mockReset()
        setShareHash('')
    })

    it('uses paired button theme colors for the missing-share action', async () => {
        render(<SharePage />)

        const backButton = await screen.findByRole('button', { name: 'share.backToSessions' })
        expect(backButton).toHaveClass('bg-[var(--app-button)]')
        expect(backButton).toHaveClass('text-[var(--app-button-text)]')
        expect(backButton).not.toHaveClass('text-white')
    })

    it('empty hash → no-id UX and does not put a transfer', async () => {
        searchMock.mockReturnValue({})
        setShareHash('')
        render(<SharePage />)

        expect(await screen.findByText('share.error.noId')).toBeInTheDocument()
        expect(putShareTransferMock).not.toHaveBeenCalled()
    })

    it('url-only hash deep-link synthesizes a transfer then replaces to ?id=', async () => {
        searchMock.mockReturnValue({})
        setShareHash('#url=https%3A%2F%2Fexample.com%2Fclip')
        putShareTransferMock.mockResolvedValue('xfer-url')

        render(<SharePage />)

        await waitFor(() => {
            expect(putShareTransferMock).toHaveBeenCalledTimes(1)
        })
        expect(putShareTransferMock.mock.calls[0][0]).toMatchObject({
            url: 'https://example.com/clip',
            text: '',
            title: '',
            files: [],
        })
        expect(navigateMock).toHaveBeenCalledWith({
            to: '/share',
            search: { id: 'xfer-url' },
            replace: true,
        })
        expect(window.location.hash).toBe('')
    })

    it('text-only hash deep-link synthesizes a transfer', async () => {
        searchMock.mockReturnValue({})
        setShareHash('#text=shared%20note')
        putShareTransferMock.mockResolvedValue('xfer-text')

        render(<SharePage />)

        await waitFor(() => {
            expect(putShareTransferMock).toHaveBeenCalledWith(
                expect.objectContaining({ text: 'shared note', url: '', title: '' }),
            )
        })
        expect(navigateMock).toHaveBeenCalledWith({
            to: '/share',
            search: { id: 'xfer-text' },
            replace: true,
        })
    })

    it('url+text hash deep-link synthesizes both fields', async () => {
        searchMock.mockReturnValue({})
        const hash = new URLSearchParams({
            url: 'https://example.com',
            text: 'caption',
            title: 'Title',
        }).toString()
        setShareHash(`#${hash}`)
        putShareTransferMock.mockResolvedValue('xfer-both')

        render(<SharePage />)

        await waitFor(() => {
            expect(putShareTransferMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    url: 'https://example.com',
                    text: 'caption',
                    title: 'Title',
                }),
            )
        })
    })

    it('StrictMode remount still ingests once and navigates to ?id=', async () => {
        searchMock.mockReturnValue({})
        setShareHash('#text=strict-mode-proof')
        putShareTransferMock.mockResolvedValue('xfer-strict')

        render(
            <StrictMode>
                <SharePage />
            </StrictMode>,
        )

        await waitFor(() => {
            expect(navigateMock).toHaveBeenCalledWith({
                to: '/share',
                search: { id: 'xfer-strict' },
                replace: true,
            })
        })
        expect(putShareTransferMock).toHaveBeenCalledTimes(1)
        expect(putShareTransferMock).toHaveBeenCalledWith(
            expect.objectContaining({ text: 'strict-mode-proof' }),
        )
        expect(window.location.hash).toBe('')
    })

    it('id present wins: loads IndexedDB and ignores hash content', async () => {
        searchMock.mockReturnValue({ id: 'xfer-existing' })
        setShareHash('#url=https%3A%2F%2Fshould-not-ingest.example&text=ignored')
        getShareTransferMock.mockResolvedValue({
            title: 'from-idb',
            text: 'payload',
            url: 'https://idb.example',
            files: [],
            createdAt: 1,
        })

        render(<SharePage />)

        expect(await screen.findByText('share.title')).toBeInTheDocument()
        expect(putShareTransferMock).not.toHaveBeenCalled()
        expect(getShareTransferMock).toHaveBeenCalledWith('xfer-existing')
        expect(navigateMock).not.toHaveBeenCalled()
        expect(window.location.hash).toBe('')
    })
})
