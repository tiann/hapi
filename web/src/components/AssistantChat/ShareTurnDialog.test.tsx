import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
                                    <button type="button" data-hapi-table-open-fullscreen="true">Open table full screen</button>
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
                                        <button type="button" data-hapi-table-open-fullscreen="true" aria-label="Open table full screen">Open table full screen</button>
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

const snapshots = [{
    html: `
        <div data-hapi-message-role="assistant">
            <div data-hapi-generated-media-id="generated-1" data-hapi-generated-media-file-name="fixture.zip">
                <button type="button" data-hapi-generated-media-download="true">Prepare download</button>
            </div>
        </div>
    `,
    text: 'Prepare download',
    role: 'assistant' as const,
}]

function renderDialog(getGeneratedMediaBlob: (imageId: string) => Promise<Blob>, isOpen = true) {
    return render(
        <I18nProvider>
            <ShareTurnDialog
                isOpen={isOpen}
                title="Generated file fixture"
                metadataItems={[]}
                sourceSnapshots={snapshots}
                getGeneratedMediaBlob={getGeneratedMediaBlob}
                onClose={vi.fn()}
            />
        </I18nProvider>
    )
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe('ShareTurnDialog generated-file lifecycle', () => {
    it('ignores a generated-file response after the preview closes', async () => {
        let resolveBlob: ((blob: Blob) => void) | undefined
        const getGeneratedMediaBlob = vi.fn(() => new Promise<Blob>((resolve) => {
            resolveBlob = resolve
        }))
        const createObjectUrl = vi.spyOn(URL, 'createObjectURL')
        const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click')
        const view = renderDialog(getGeneratedMediaBlob)

        fireEvent.click(await screen.findByRole('button', { name: 'Prepare download' }))
        await waitFor(() => expect(getGeneratedMediaBlob).toHaveBeenCalledWith('generated-1'))

        view.rerender(
            <I18nProvider>
                <ShareTurnDialog
                    isOpen={false}
                    title="Generated file fixture"
                    metadataItems={[]}
                    sourceSnapshots={snapshots}
                    getGeneratedMediaBlob={getGeneratedMediaBlob}
                    onClose={vi.fn()}
                />
            </I18nProvider>
        )

        await act(async () => {
            resolveBlob?.(new Blob(['file'], { type: 'application/zip' }))
            await Promise.resolve()
            await Promise.resolve()
        })

        expect(createObjectUrl).not.toHaveBeenCalled()
        expect(anchorClick).not.toHaveBeenCalled()
    })
})
