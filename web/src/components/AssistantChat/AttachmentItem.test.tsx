import type { ComponentProps, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'

const mocks = vi.hoisted(() => ({
    attachment: {
        name: 'photo.png',
        status: { type: 'requires-action', reason: 'composer-send' },
        previewUrl: 'data:image/png;base64,cGhvdG8='
    } as Record<string, unknown>,
    composer: {
        addAttachment: vi.fn(async (_file: File) => {}),
        getState: vi.fn(() => ({ attachments: [] })),
        subscribe: vi.fn((_listener: () => void) => () => {}),
    },
    attachmentRuntime: {
        remove: vi.fn(async () => {}),
    }
}))

vi.mock('@assistant-ui/react', () => ({
    useThreadComposerAttachment: () => mocks.attachment,
    useComposerRuntime: () => mocks.composer,
    useThreadComposerAttachmentRuntime: () => mocks.attachmentRuntime,
    AttachmentPrimitive: {
        Root: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
        Remove: ({ children, ...props }: ComponentProps<'button'> & { children?: ReactNode }) => (
            <button {...props}>{children}</button>
        )
    }
}))

import { AttachmentItem } from './AttachmentItem'

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
})

beforeEach(() => {
    mocks.composer.addAttachment.mockClear()
    mocks.composer.getState.mockReset()
    mocks.composer.getState.mockReturnValue({ attachments: [] })
    mocks.composer.subscribe.mockClear()
    mocks.attachmentRuntime.remove.mockClear()
})

function renderAttachment() {
    return render(
        <I18nProvider>
            <AttachmentItem />
        </I18nProvider>
    )
}

function renderAttachmentWithControls() {
    return render(
        <I18nProvider>
            <AttachmentItem
                dragHandleProps={{
                    onPointerDown: vi.fn(),
                    onKeyDown: vi.fn(),
                    ariaLabel: 'Reorder attachment notes.txt',
                    title: 'Drag to reorder attachment',
                }}
            />
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

    it('uses centered, unboxed controls for non-image attachments', () => {
        mocks.attachment = {
            name: 'notes.txt',
            status: { type: 'requires-action', reason: 'composer-send' }
        }

        renderAttachmentWithControls()

        const dragHandle = screen.getByTestId('attachment-drag-handle')
        const removeButton = screen.getByRole('button', { name: 'Remove attachment' })
        expect(dragHandle.parentElement).toHaveClass('gap-1.5', 'px-2')

        for (const control of [dragHandle, removeButton]) {
            expect(control).toHaveClass('hapi-composer-attachment-file-control', 'h-6', 'w-6', 'items-center')
            expect(control).not.toHaveClass('absolute', 'top-1/2', '-translate-y-1/2')
            expect(control.querySelector('span')).toBeNull()
        }
        expect(dragHandle).toHaveClass('-mx-1')
        expect(removeButton).toHaveClass('-mx-1')
    })

    it('renders a failed upload with an inline retry icon', () => {
        const file = new File(['broken'], 'broken.png', { type: 'image/png' })
        mocks.attachment = {
            name: 'broken.png',
            file,
            status: { type: 'incomplete', reason: 'error' },
            previewUrl: 'data:image/png;base64,YnJva2Vu'
        }

        renderAttachmentWithControls()

        expect(screen.queryByRole('img')).not.toBeInTheDocument()
        expect(screen.queryByText('Upload failed')).not.toBeInTheDocument()
        expect(screen.queryByText('Retry')).not.toBeInTheDocument()
        expect(screen.queryByTestId('attachment-drag-handle')).not.toBeInTheDocument()
        expect(screen.getByText('broken.png')).toHaveClass('line-through')
        expect(screen.getByRole('button', { name: 'Retry upload' })).toBeInTheDocument()
        const retryButton = screen.getByRole('button', { name: 'Retry upload' })
        expect(retryButton).toHaveClass('hapi-composer-attachment-file-control', 'h-6', 'w-6', '-mx-1', 'items-center')
        expect(screen.getByRole('button', { name: 'Remove attachment' })).toHaveClass(
            'hapi-composer-attachment-file-control', 'h-6', 'w-6', '-mx-1', 'items-center',
        )
        expect(screen.getByRole('button', { name: 'Remove attachment' })).not.toHaveStyle({ marginLeft: '-7px' })
        expect(retryButton.querySelector('svg')).toHaveClass('h-[18px]', 'w-[18px]')
        expect(retryButton.querySelector('svg')).toHaveAttribute('viewBox', '0 0 24 24')
    })

    it('retries a failed upload with the original file', async () => {
        const file = new File(['broken'], 'broken.png', { type: 'image/png' })
        mocks.attachment = {
            id: 'broken-attachment',
            name: file.name,
            file,
            status: { type: 'incomplete', reason: 'error' },
        }

        renderAttachment()
        fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }))

        await waitFor(() => {
            expect(mocks.attachmentRuntime.remove).toHaveBeenCalledOnce()
            expect(mocks.composer.addAttachment).toHaveBeenCalledOnce()
        })

        const retryFile = mocks.composer.addAttachment.mock.calls[0]?.[0] as File
        expect(retryFile).not.toBe(file)
        expect(retryFile).toMatchObject({
            name: file.name,
            type: file.type,
            lastModified: file.lastModified,
        })
        expect(retryFile.size).toBe(file.size)
    })

    it('reports the fresh retry id with the original attachment index', async () => {
        const file = new File(['broken'], 'broken.png', { type: 'image/png' })
        const attachmentOrderRef = { current: ['first-attachment', 'broken-attachment', 'last-attachment'] }
        const onRetry = vi.fn()
        const unsubscribe = vi.fn()
        mocks.attachment = {
            id: 'broken-attachment',
            name: file.name,
            file,
            status: { type: 'incomplete', reason: 'error' },
        }
        mocks.composer.subscribe.mockImplementationOnce((listener: () => void) => {
            mocks.composer.addAttachment.mockImplementationOnce(async (retryFile: File) => {
                mocks.composer.getState.mockReturnValue({
                    attachments: [{ id: 'retried-attachment', file: retryFile }] as never[],
                })
                listener()
            })
            return unsubscribe
        })

        render(
            <I18nProvider>
                <AttachmentItem attachmentOrderRef={attachmentOrderRef} onRetry={onRetry} />
            </I18nProvider>,
        )
        fireEvent.click(screen.getByRole('button', { name: 'Retry upload' }))

        await waitFor(() => {
            expect(onRetry).toHaveBeenCalledWith('broken-attachment', 'retried-attachment', 1)
        })
        expect(unsubscribe).toHaveBeenCalledOnce()
    })

    it('keeps an error indicator without retrying non-retryable files', () => {
        mocks.attachment = {
            name: 'oversized.bin',
            file: { name: 'oversized.bin', size: 1, type: 'application/octet-stream' } as File,
            status: { type: 'incomplete', reason: 'error' },
            retryable: false,
        }

        renderAttachmentWithControls()

        expect(screen.queryByRole('button', { name: 'Retry upload' })).not.toBeInTheDocument()
        expect(screen.getByTestId('attachment-error-icon')).toBeInTheDocument()
        expect(screen.getByText('Upload failed')).toHaveClass('sr-only')
    })

    it('rechecks filename truncation when an image enters the error layout', () => {
        vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(200)
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
        const file = new File(['broken'], 'a-very-long-filename-that-needs-truncation.png', { type: 'image/png' })
        mocks.attachment = {
            name: file.name,
            file,
            status: { type: 'running', reason: 'uploading', progress: 0 },
            previewUrl: 'data:image/png;base64,YnJva2Vu',
        }
        const view = renderAttachment()

        mocks.attachment = {
            name: file.name,
            file,
            status: { type: 'incomplete', reason: 'error' },
            previewUrl: 'data:image/png;base64,YnJva2Vu',
        }
        view.rerender(
            <I18nProvider>
                <AttachmentItem />
            </I18nProvider>,
        )

        expect(screen.getByRole('button', { name: 'Remove attachment' })).toHaveStyle({ marginLeft: '-7px' })
    })
})
