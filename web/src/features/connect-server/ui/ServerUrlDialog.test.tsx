import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import { ServerUrlDialog } from './ServerUrlDialog'

vi.mock('@/hooks/useServerUrl', () => ({
    useServerUrl: vi.fn()
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key
    })
}))

vi.mock('@/shared/ui/dialog', () => ({
    Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
        open ? <div data-testid="dialog">{children}</div> : null,
    DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>
}))

vi.mock('@/shared/ui/button', () => ({
    Button: ({ children, onClick, type, variant }: {
        children: React.ReactNode
        onClick?: () => void
        type?: string
        variant?: string
    }) => (
        <button onClick={onClick} type={type} data-variant={variant}>
            {children}
        </button>
    )
}))

import { useServerUrl } from '@/hooks/useServerUrl'

describe('ServerUrlDialog', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        cleanup()
    })

    it('renders dialog when open', () => {
        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: null,
            baseUrl: 'http://localhost',
            setServerUrl: vi.fn(() => ({ ok: true, value: 'http://example.com' })),
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={vi.fn()}
            />
        )

        expect(screen.getByTestId('dialog')).toBeInTheDocument()
        expect(screen.getByText('settings.serverUrl.title')).toBeInTheDocument()
    })

    it('does not render when closed', () => {
        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: null,
            baseUrl: 'http://localhost',
            setServerUrl: vi.fn(() => ({ ok: true, value: 'http://example.com' })),
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={false}
                onClose={vi.fn()}
            />
        )

        expect(screen.queryByTestId('dialog')).not.toBeInTheDocument()
    })

    it('displays current server URL in input', () => {
        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: 'https://example.com',
            baseUrl: 'https://example.com',
            setServerUrl: vi.fn(() => ({ ok: true, value: 'https://example.com' })),
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={vi.fn()}
            />
        )

        const input = screen.getByPlaceholderText('https://example.com') as HTMLInputElement
        expect(input.value).toBe('https://example.com')
    })

    it('calls setServerUrl and closes on valid submit', async () => {
        const setServerUrl = vi.fn(() => ({ ok: true, value: 'https://newserver.com' }))
        const onClose = vi.fn()

        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: null,
            baseUrl: 'http://localhost',
            setServerUrl,
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={onClose}
            />
        )

        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.change(input, { target: { value: 'https://newserver.com' } })

        const saveButton = screen.getByText('button.save')
        fireEvent.click(saveButton)

        expect(setServerUrl).toHaveBeenCalledWith('https://newserver.com')
        expect(onClose).toHaveBeenCalled()
    })

    it('displays error message when setServerUrl fails', async () => {
        const setServerUrl = vi.fn(() => ({ ok: false, error: 'Invalid URL' }))

        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: null,
            baseUrl: 'http://localhost',
            setServerUrl,
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={vi.fn()}
            />
        )

        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.change(input, { target: { value: 'invalid-url' } })

        const saveButton = screen.getByText('button.save')
        fireEvent.click(saveButton)

        await waitFor(() => {
            expect(screen.getByText('Invalid URL')).toBeInTheDocument()
        })
    })

    it('calls clearServerUrl and closes when clear button clicked', async () => {
        const clearServerUrl = vi.fn()
        const onClose = vi.fn()

        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: 'https://example.com',
            baseUrl: 'https://example.com',
            setServerUrl: vi.fn(() => ({ ok: true, value: 'https://example.com' })),
            clearServerUrl
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={onClose}
            />
        )

        const clearButton = screen.getByText('button.clear')
        fireEvent.click(clearButton)

        expect(clearServerUrl).toHaveBeenCalled()
        expect(onClose).toHaveBeenCalled()
    })

    it('calls onClose when cancel button clicked', async () => {
        const onClose = vi.fn()

        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: null,
            baseUrl: 'http://localhost',
            setServerUrl: vi.fn(() => ({ ok: true, value: 'http://example.com' })),
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={onClose}
            />
        )

        const cancelButton = screen.getByText('button.cancel')
        fireEvent.click(cancelButton)

        expect(onClose).toHaveBeenCalled()
    })

    it('allows typing in the input field', async () => {
        vi.mocked(useServerUrl).mockReturnValue({
            serverUrl: null,
            baseUrl: 'http://localhost',
            setServerUrl: vi.fn(() => ({ ok: true, value: 'https://test.com' })),
            clearServerUrl: vi.fn()
        })

        render(
            <ServerUrlDialog
                isOpen={true}
                onClose={vi.fn()}
            />
        )

        const input = screen.getByPlaceholderText('https://example.com')
        fireEvent.change(input, { target: { value: 'https://test.com' } })

        expect(input).toHaveValue('https://test.com')
    })
})
