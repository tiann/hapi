import type { ComponentProps, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

const mocks = vi.hoisted(() => ({
    attachment: {
        name: 'photo.png',
        status: { type: 'requires-action', reason: 'composer-send' },
        previewUrl: 'data:image/png;base64,cGhvdG8='
    } as Record<string, unknown>
}))

vi.mock('@assistant-ui/react', () => ({
    useThreadComposerAttachment: () => mocks.attachment,
    AttachmentPrimitive: {
        Root: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
        Remove: ({ children, ...props }: ComponentProps<'button'> & { children?: ReactNode }) => (
            <button {...props}>{children}</button>
        )
    }
}))

import { AttachmentItem } from './AttachmentItem'

afterEach(() => cleanup())

function renderAttachment() {
    return render(
        <I18nProvider>
            <AttachmentItem />
        </I18nProvider>
    )
}

describe('AttachmentItem', () => {
    it('renders an image preview with its filename and an always-visible remove button', () => {
        mocks.attachment = {
            name: 'photo.png',
            status: { type: 'requires-action', reason: 'composer-send' },
            previewUrl: 'data:image/png;base64,cGhvdG8='
        }

        renderAttachment()

        expect(screen.getByRole('img', { name: 'photo.png' })).toHaveAttribute(
            'src',
            'data:image/png;base64,cGhvdG8='
        )
        expect(screen.getAllByText('photo.png')).toHaveLength(2)
        expect(screen.getByRole('button', { name: 'Remove attachment' })).not.toHaveClass('opacity-0')
    })

    it('keeps the upload indicator on top of an image preview while uploading', () => {
        mocks.attachment = {
            name: 'uploading.png',
            status: { type: 'running', reason: 'uploading', progress: 0 },
            previewUrl: 'data:image/png;base64,dXBsb2FkaW5n'
        }

        const { container } = renderAttachment()

        expect(screen.getByRole('img', { name: 'uploading.png' })).toBeInTheDocument()
        expect(container.querySelector('[class*="bg-black/40"]')).not.toBeNull()
    })

    it('opens the same zoomable image viewer used by sent attachments', () => {
        mocks.attachment = {
            name: 'zoom-me.png',
            status: { type: 'requires-action', reason: 'composer-send' },
            previewUrl: 'data:image/png;base64,em9vbQ=='
        }

        renderAttachment()
        fireEvent.click(screen.getByTitle('Click to zoom'))

        const dialog = screen.getByRole('dialog', { name: 'zoom-me.png' })
        expect(dialog).toBeInTheDocument()
        expect(screen.getAllByRole('img', { name: 'zoom-me.png' })).toHaveLength(2)
    })

    it('keeps non-image attachments in the filename chip layout', () => {
        mocks.attachment = {
            name: 'notes.txt',
            status: { type: 'requires-action', reason: 'composer-send' }
        }

        renderAttachment()

        expect(screen.queryByRole('img')).not.toBeInTheDocument()
        expect(screen.getByText('notes.txt')).toBeInTheDocument()
    })

    it('keeps upload errors in the existing error layout', () => {
        mocks.attachment = {
            name: 'broken.png',
            status: { type: 'incomplete', reason: 'error' },
            previewUrl: 'data:image/png;base64,YnJva2Vu'
        }

        renderAttachment()

        expect(screen.queryByRole('img')).not.toBeInTheDocument()
        expect(screen.getByText('Upload failed')).toBeInTheDocument()
        expect(screen.getByText('broken.png')).toHaveClass('line-through')
    })
})
