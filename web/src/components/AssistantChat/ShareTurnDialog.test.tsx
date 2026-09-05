import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { ShareTurnDialog } from './ShareTurnDialog'
import { stripCaptureOnlyControls, stripExportControls } from './ShareTurnDialog'

const html2canvas = vi.hoisted(() => vi.fn())
vi.mock('html2canvas-pro', () => ({ default: html2canvas }))

describe('ShareTurnDialog preview cleanup', () => {
    beforeEach(() => {
        html2canvas.mockReset()
        html2canvas.mockResolvedValue({
            toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })),
        })
    })

    it('keeps table fullscreen controls interactive in the preview but removes them from exports', () => {
        const root = document.createElement('div')
        root.innerHTML = `
            <div class="aui-md-table-frame">
                <table class="aui-md-table">
                    <thead><tr><th>Configuration</th></tr></thead>
                    <tbody><tr><td>apiUrl</td></tr></tbody>
                </table>
                <div class="aui-md-table-actions">
                    <button type="button">Open table full screen</button>
                </div>
            </div>
        `

        stripCaptureOnlyControls(root)

        expect(root.querySelector('.aui-md-table-actions')).not.toBeNull()
        expect(root.querySelector('table')).not.toBeNull()
        expect(root).toHaveTextContent('apiUrl')

        stripExportControls(root)
        expect(root.querySelector('.aui-md-table-actions')).toBeNull()
    })

    it('preserves the link target for Markdown copied from the share preview', () => {
        const root = document.createElement('div')
        root.innerHTML = '<a href="https://example.com/docs">Docs</a>'

        stripCaptureOnlyControls(root)

        const anchor = root.querySelector('a')
        expect(anchor).not.toHaveAttribute('href')
        expect(anchor).toHaveAttribute('data-hapi-markdown-href', 'https://example.com/docs')
    })

    it('opens the shared table viewer from the preview action', async () => {
        render(
            <I18nProvider>
                <ShareTurnDialog
                    isOpen
                    title="Share table"
                    metadataItems={[]}
                    sourceSnapshots={[{
                        html: `
                            <div>
                                <div class="aui-md-table-frame">
                                    <table class="aui-md-table">
                                        <thead><tr><th>Configuration</th></tr></thead>
                                        <tbody><tr><td>apiUrl</td></tr></tbody>
                                    </table>
                                    <div class="aui-md-table-actions">
                                        <button type="button" aria-label="Open table full screen">Open table full screen</button>
                                    </div>
                                </div>
                            </div>
                        `,
                        text: 'Configuration apiUrl',
                    }]}
                    onClose={vi.fn()}
                />
            </I18nProvider>,
        )

        fireEvent.click(await screen.findByRole('button', { name: 'Open table full screen' }))
        expect(await screen.findByRole('dialog', { name: 'Share table' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Close table full screen' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Close table full screen' }))
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Close table full screen' })).not.toBeInTheDocument())
    })
})
