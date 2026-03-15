import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MessageAttachments } from './MessageAttachments'
import type { AttachmentMetadata } from '@/types/api'

// Mock FileIcon component
vi.mock('@/components/FileIcon', () => ({
    FileIcon: () => <div data-testid="file-icon" />,
}))

// Mock helper functions
vi.mock('@/lib/fileAttachments', () => ({
    isImageMimeType: (mimeType: string) => mimeType.startsWith('image/'),
}))

describe('MessageAttachments', () => {
    it('returns null when no attachments', () => {
        const { container } = render(<MessageAttachments attachments={[]} />)
        expect(container.firstChild).toBeNull()
    })

    it('renders image attachments with preview', () => {
        const attachments: AttachmentMetadata[] = [
            {
                id: 'img-1',
                filename: 'photo.jpg',
                mimeType: 'image/jpeg',
                size: 1024000,
                path: '/uploads/photo.jpg',
                previewUrl: 'data:image/jpeg;base64,abc123',
            },
        ]

        render(<MessageAttachments attachments={attachments} />)

        const img = screen.getByAltText('photo.jpg')
        expect(img).toBeInTheDocument()
        expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,abc123')
        expect(screen.getByText('photo.jpg')).toBeInTheDocument()
    })

    it('renders file attachments without preview', () => {
        const attachments: AttachmentMetadata[] = [
            {
                id: 'file-1',
                filename: 'document.pdf',
                mimeType: 'application/pdf',
                size: 2048000,
                path: '/uploads/document.pdf',
            },
        ]

        render(<MessageAttachments attachments={attachments} />)

        expect(screen.getByText('document.pdf')).toBeInTheDocument()
        expect(screen.getByText('2.0 MB')).toBeInTheDocument()
        expect(screen.getAllByTestId('file-icon')).toHaveLength(1)
    })

    it('formats file sizes correctly', () => {
        const attachments: AttachmentMetadata[] = [
            {
                id: 'file-1',
                filename: 'small.txt',
                mimeType: 'text/plain',
                size: 512,
                path: '/uploads/small.txt',
            },
            {
                id: 'file-2',
                filename: 'medium.txt',
                mimeType: 'text/plain',
                size: 1536,
                path: '/uploads/medium.txt',
            },
            {
                id: 'file-3',
                filename: 'large.txt',
                mimeType: 'text/plain',
                size: 5242880,
                path: '/uploads/large.txt',
            },
        ]

        render(<MessageAttachments attachments={attachments} />)

        expect(screen.getByText('512 B')).toBeInTheDocument()
        expect(screen.getByText('1.5 KB')).toBeInTheDocument()
        expect(screen.getByText('5.0 MB')).toBeInTheDocument()
    })

    it('renders mixed image and file attachments', () => {
        const attachments: AttachmentMetadata[] = [
            {
                id: 'img-1',
                filename: 'photo.png',
                mimeType: 'image/png',
                size: 1024000,
                path: '/uploads/photo.png',
                previewUrl: 'data:image/png;base64,xyz',
            },
            {
                id: 'file-1',
                filename: 'report.pdf',
                mimeType: 'application/pdf',
                size: 2048000,
                path: '/uploads/report.pdf',
            },
        ]

        render(<MessageAttachments attachments={attachments} />)

        // Should render both image and file
        expect(screen.getByAltText('photo.png')).toBeInTheDocument()
        const reportText = screen.getAllByText('report.pdf')[0]
        expect(reportText).toBeInTheDocument()
    })

    it('treats images without preview as files', () => {
        const attachments: AttachmentMetadata[] = [
            {
                id: 'img-1',
                filename: 'large-image.jpg',
                mimeType: 'image/jpeg',
                size: 10485760, // 10MB
                path: '/uploads/large-image.jpg',
                // No previewUrl
            },
        ]

        render(<MessageAttachments attachments={attachments} />)

        // Should render as file attachment, not image
        expect(screen.queryByAltText('large-image.jpg')).not.toBeInTheDocument()
        const filenameText = screen.getAllByText('large-image.jpg')[0]
        expect(filenameText).toBeInTheDocument()
        expect(screen.getByText('10.0 MB')).toBeInTheDocument()
    })

    it('renders multiple images in a grid', () => {
        const attachments: AttachmentMetadata[] = [
            {
                id: 'img-1',
                filename: 'photo1.jpg',
                mimeType: 'image/jpeg',
                size: 1024000,
                path: '/uploads/photo1.jpg',
                previewUrl: 'data:image/jpeg;base64,abc1',
            },
            {
                id: 'img-2',
                filename: 'photo2.jpg',
                mimeType: 'image/jpeg',
                size: 1024000,
                path: '/uploads/photo2.jpg',
                previewUrl: 'data:image/jpeg;base64,abc2',
            },
        ]

        const { container } = render(<MessageAttachments attachments={attachments} />)

        const imageGrids = container.querySelectorAll('.flex-wrap')
        expect(imageGrids.length).toBeGreaterThan(0)

        // Get images by alt text to avoid counting other elements
        expect(screen.getByAltText('photo1.jpg')).toBeInTheDocument()
        expect(screen.getByAltText('photo2.jpg')).toBeInTheDocument()
    })
})
