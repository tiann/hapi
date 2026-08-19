import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { SessionExportDialog } from './SessionExportDialog'

const downloadSessionExport = vi.hoisted(() => vi.fn())
const readSessionExportFormat = vi.hoisted(() => vi.fn(() => 'json'))
const writeSessionExportFormat = vi.hoisted(() => vi.fn())

vi.mock('@/lib/sessionExport/download', () => ({
    downloadSessionExport,
    readSessionExportFormat,
    writeSessionExportFormat
}))

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

function renderDialog(onClose = vi.fn()) {
    render(
        <I18nProvider>
            <ToastProvider>
                <SessionExportDialog
                    isOpen={true}
                    onClose={onClose}
                    sessionId="session-1"
                    api={{} as ApiClient}
                />
            </ToastProvider>
        </I18nProvider>
    )
    return onClose
}

const warning = {
    type: 'warning' as const,
    count: 20_001,
    limit: 20_000,
    sizeBytes: 12_345_678
}

describe('SessionExportDialog exports', () => {
    it('downloads a normal export without a confirmation step', async () => {
        downloadSessionExport.mockResolvedValueOnce({ type: 'download', filename: 'export', messageCount: 2 })
        const onClose = renderDialog()

        fireEvent.click(screen.getByRole('button', { name: 'Download' }))

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
        expect(downloadSessionExport).toHaveBeenCalledTimes(1)
        expect(downloadSessionExport).toHaveBeenCalledWith(
            expect.anything(),
            'session-1',
            'json',
            expect.objectContaining({ allowLarge: false, signal: expect.any(AbortSignal) })
        )
    })

    it('requires confirmation and does not download when cancelled', async () => {
        downloadSessionExport.mockResolvedValueOnce(warning)
        const onClose = renderDialog()

        fireEvent.click(screen.getByRole('button', { name: 'Download' }))

        await waitFor(() => expect(screen.getByText(/20001/)).toBeInTheDocument())
        expect(screen.getByRole('button', { name: 'Download anyway' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(onClose).toHaveBeenCalledTimes(1)
        expect(downloadSessionExport).toHaveBeenCalledTimes(1)
    })

    it.each(['json', 'markdown'] as const)('downloads a large %s export after confirmation', async (format) => {
        downloadSessionExport
            .mockResolvedValueOnce(warning)
            .mockResolvedValueOnce({ type: 'download', filename: 'export', messageCount: 20_001 })
        const onClose = renderDialog()

        if (format === 'markdown') {
            fireEvent.click(screen.getByDisplayValue('markdown'))
        }
        fireEvent.click(screen.getByRole('button', { name: 'Download' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Download anyway' })).toBeInTheDocument())

        fireEvent.click(screen.getByRole('button', { name: 'Download anyway' }))

        await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
        expect(downloadSessionExport).toHaveBeenNthCalledWith(
            2,
            expect.anything(),
            'session-1',
            format,
            expect.objectContaining({ allowLarge: true, signal: expect.any(AbortSignal) })
        )
    })
})
