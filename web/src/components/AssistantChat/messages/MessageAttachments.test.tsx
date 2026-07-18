import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageAttachments } from './MessageAttachments'
import type { AttachmentMetadata } from '@/types/api'

const pdfAttachment: AttachmentMetadata = {
    id: 'agent-att-pdf',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    size: 24_645,
    path: 'hapi-agent-inline://agent-att-pdf/report.pdf',
    previewUrl: 'data:application/pdf;base64,JVBERi0xLjQ='
}

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
})

describe('MessageAttachments', () => {
    it('opens a stable in-app actions dialog for data-url file attachments before download', () => {
        const createObjectURL = vi.fn(() => 'blob:hapi-attachment-report')
        const revokeObjectURL = vi.fn()
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL,
            revokeObjectURL
        })

        render(<MessageAttachments attachments={[pdfAttachment]} />)

        expect(screen.queryByRole('link', { name: /download report\.pdf/i })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /open attachment actions for report\.pdf/i }))

        const dialog = screen.getByRole('dialog')
        expect(dialog).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'report.pdf' })).toBeInTheDocument()
        expect(dialog).toHaveTextContent('24.1 KB')
        expect(createObjectURL).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('link', { name: /open report\.pdf/i })).toHaveAttribute('href', 'blob:hapi-attachment-report')
        expect(screen.getByRole('link', { name: /download report\.pdf/i })).toHaveAttribute('download', 'report.pdf')
        expect(screen.getByRole('link', { name: /download report\.pdf/i })).toHaveAttribute('href', 'blob:hapi-attachment-report')
    })

    it('renders unsafe preview URLs as static cards without open or download actions', () => {
        render(
            <MessageAttachments
                attachments={[{
                    id: 'agent-att-js',
                    filename: 'script.txt',
                    mimeType: 'text/plain',
                    size: 5,
                    path: 'hapi-agent-inline://agent-att-js/script.txt',
                    previewUrl: 'javascript:alert(1)'
                }, {
                    id: 'agent-att-html',
                    filename: 'page.html',
                    mimeType: 'text/html',
                    size: 14,
                    path: 'hapi-agent-inline://agent-att-html/page.html',
                    previewUrl: 'data:text/html;base64,PGh0bWw+'
                }, {
                    id: 'agent-att-svg',
                    filename: 'image.png',
                    mimeType: 'image/png',
                    size: 11,
                    path: 'hapi-agent-inline://agent-att-svg/image.png',
                    previewUrl: 'data:image/svg+xml;base64,PHN2Zz4='
                }, {
                    id: 'agent-att-invalid',
                    filename: 'invalid.pdf',
                    mimeType: 'application/pdf',
                    size: 9,
                    path: 'hapi-agent-inline://agent-att-invalid/invalid.pdf',
                    previewUrl: 'data:,not-base64'
                }]}
            />
        )

        expect(screen.getByText('script.txt')).toBeInTheDocument()
        expect(screen.getByText('page.html')).toBeInTheDocument()
        expect(screen.getByText('image.png')).toBeInTheDocument()
        expect(screen.getByText('invalid.pdf')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /open attachment actions/i })).not.toBeInTheDocument()
        expect(screen.queryByRole('link')).not.toBeInTheDocument()
        expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })

    it('renders safe image previews and falls back to file actions if image loading fails', () => {
        render(
            <MessageAttachments
                attachments={[{
                    id: 'agent-att-image',
                    filename: 'chart.png',
                    mimeType: 'image/png',
                    size: 15,
                    path: 'hapi-agent-inline://agent-att-image/chart.png',
                    previewUrl: 'data:image/png;base64,iVBORw0KGgo='
                }]}
            />
        )

        const image = screen.getByRole('img', { name: 'chart.png' })
        expect(image).toHaveAttribute('src', 'data:image/png;base64,iVBORw0KGgo=')

        fireEvent.error(image)

        expect(screen.queryByRole('img', { name: 'chart.png' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: /open attachment actions for chart\.png/i })).toBeInTheDocument()
    })

    it('revokes data-url object URLs on unmount', () => {
        const createObjectURL = vi.fn(() => 'blob:hapi-attachment-report')
        const revokeObjectURL = vi.fn()
        vi.stubGlobal('URL', {
            ...URL,
            createObjectURL,
            revokeObjectURL
        })

        const { unmount } = render(<MessageAttachments attachments={[pdfAttachment]} />)

        expect(createObjectURL).toHaveBeenCalledTimes(1)

        unmount()

        expect(revokeObjectURL).toHaveBeenCalledWith('blob:hapi-attachment-report')
    })
})
