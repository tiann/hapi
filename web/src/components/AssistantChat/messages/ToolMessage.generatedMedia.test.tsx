import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { computeTinyImageScale, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'

function renderCard(options: {
    mimeType: string | null
    locale?: 'en' | 'zh-CN'
    getGeneratedImageBlob?: ReturnType<typeof vi.fn>
}) {
    if (options.locale) {
        localStorage.setItem('hapi-lang', options.locale)
    } else {
        localStorage.removeItem('hapi-lang')
    }

    const getGeneratedImageBlob = options.getGeneratedImageBlob ?? vi.fn(async () => new Blob(['x'], { type: options.mimeType ?? 'image/png' }))
    const api = { getGeneratedImageBlob } as unknown as ApiClient
    const value: HappyChatContextValue = {
        api,
        sessionId: 'session-1',
        metadata: null,
        terminalToolDisplayMode: 'compact',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'loaded',
    }

    render(
        <I18nProvider>
            <HappyChatProvider value={value}>
                <GeneratedImageCard
                    block={{
                        kind: 'generated-image',
                        id: 'block-1',
                        localId: null,
                        createdAt: 1,
                        imageId: 'img-1',
                        fileName: 'clip.mp4',
                        mimeType: options.mimeType,
                    }}
                />
            </HappyChatProvider>
        </I18nProvider>
    )

    return { getGeneratedImageBlob }
}

describe('GeneratedImageCard media fetch', () => {
    it('labels displayed images in English without implying AI generation', () => {
        renderCard({ mimeType: 'image/png', locale: 'en' })

        expect(screen.getByText('Displayed image: clip.mp4')).toBeInTheDocument()
        expect(screen.queryByText(/Generated image/)).not.toBeInTheDocument()
    })

    it('localizes the displayed image label in Chinese', () => {
        renderCard({ mimeType: 'image/png', locale: 'zh-CN' })

        expect(screen.getByText('展示图片：clip.mp4')).toBeInTheDocument()
        expect(screen.queryByText(/Generated image/)).not.toBeInTheDocument()
    })

    it('does not call the API for an untouched video card', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'video/mp4' })

        expect(screen.getByRole('button', { name: 'Load video' })).toBeInTheDocument()
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(getGeneratedImageBlob).not.toHaveBeenCalled()
    })

    it('fetches the blob after the user clicks Load video', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'video/mp4' })

        fireEvent.click(screen.getByRole('button', { name: 'Load video' }))

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-1')
        })
    })

    it('still fetches images on mount', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'image/png' })

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-1')
        })
    })

    it('keeps tiny image previews sized to their content instead of stretching the frame', async () => {
        renderCard({ mimeType: 'image/png' })

        const image = await screen.findByRole('img', { name: 'clip.mp4' })
        const frame = image.parentElement?.parentElement
        if (!frame) throw new Error('Expected generated image frame')
        const card = frame.parentElement
        if (!card) throw new Error('Expected generated image card')

        expect(frame).toHaveClass('w-fit', 'max-w-full')
        expect(frame).not.toHaveClass('min-h-32', 'min-w-[12rem]')
        expect(card).toHaveClass('w-fit', 'max-w-[92%]')
    })

    it('reserves layout space when scaling a skinny tiny image', async () => {
        expect(computeTinyImageScale(16, 32)).toBe(2)

        class MockImage {
            naturalWidth = 16
            naturalHeight = 32
            onload: (() => void) | null = null

            set src(_value: string) {
                queueMicrotask(() => this.onload?.())
            }
        }

        vi.stubGlobal('Image', MockImage)
        try {
            renderCard({ mimeType: 'image/png' })
            const image = await screen.findByRole('img', { name: 'clip.mp4' })

            await waitFor(() => {
                expect(image).toHaveStyle({ width: '32px', height: '64px' })
            })
            expect(image).not.toHaveStyle({ transform: 'scale(2)' })
        } finally {
            vi.unstubAllGlobals()
        }
    })

    it('shows a friendly error and retries a failed image load', async () => {
        const getGeneratedImageBlob = vi.fn()
            .mockRejectedValueOnce(new Error('HTTP 404'))
            .mockResolvedValueOnce(new Blob(['x'], { type: 'image/png' }))
        renderCard({ mimeType: 'image/png', locale: 'en', getGeneratedImageBlob })

        await waitFor(() => {
            expect(screen.getByText('Displayed image is currently unavailable.')).toBeInTheDocument()
        })
        expect(screen.queryByText('HTTP 404')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Displayed image is currently unavailable\. Retry/ }))

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledTimes(2)
            expect(screen.getByRole('img', { name: 'clip.mp4' })).toBeInTheDocument()
        })
    })

    it('localizes the failed image retry state in Simplified Chinese', async () => {
        const getGeneratedImageBlob = vi.fn().mockRejectedValue(new Error('HTTP 404'))
        renderCard({ mimeType: 'image/png', locale: 'zh-CN', getGeneratedImageBlob })

        await waitFor(() => {
            expect(screen.getByText('展示图片暂不可用。')).toBeInTheDocument()
            expect(screen.getByText('重新加载')).toBeInTheDocument()
        })
        expect(screen.queryByText('HTTP 404')).not.toBeInTheDocument()
    })

    it('loads audio on demand and renders controls', async () => {
        renderCard({ mimeType: 'audio/wav' })

        fireEvent.click(screen.getByRole('button', { name: 'Load audio' }))

        await waitFor(() => {
            expect(document.querySelector('audio[controls]')).toBeInTheDocument()
        })
    })

    it('loads unknown files on demand and renders a download link', async () => {
        renderCard({ mimeType: 'application/octet-stream' })

        fireEvent.click(screen.getByRole('button', { name: 'Prepare download' }))

        await waitFor(() => {
            expect(screen.getByRole('link', { name: /Download clip\.mp4/ })).toHaveAttribute('download', 'clip.mp4')
        })
    })
})
