import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'

function renderCard(options: {
    mimeType: string | null
    locale?: 'en' | 'zh-CN'
    getGeneratedImageBlob?: ReturnType<typeof vi.fn>
    getGeneratedImageMetadata?: ReturnType<typeof vi.fn>
}) {
    if (options.locale) {
        localStorage.setItem('hapi-lang', options.locale)
    } else {
        localStorage.removeItem('hapi-lang')
    }

    const getGeneratedImageBlob = options.getGeneratedImageBlob ?? vi.fn(async () => new Blob(['x'], { type: options.mimeType ?? 'image/png' }))
    const getGeneratedImageMetadata = options.getGeneratedImageMetadata ?? vi.fn(async () => ({ success: false }))
    const api = { getGeneratedImageBlob, getGeneratedImageMetadata } as unknown as ApiClient
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

    return { getGeneratedImageBlob, getGeneratedImageMetadata }
}

describe('GeneratedImageCard video fetch', () => {
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
        expect(screen.getByRole('button', { name: 'Load video' })).not.toHaveClass('h-48')
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

    it('loads audio on demand and renders controls', async () => {
        renderCard({ mimeType: 'audio/wav', locale: 'zh-CN' })

        fireEvent.click(screen.getByRole('button', { name: '加载音频' }))

        await waitFor(() => {
            expect(document.querySelector('audio[controls]')).toBeInTheDocument()
        })
    })

    it('loads unknown files on demand and renders a download link', async () => {
        const getGeneratedImageBlob = vi.fn(async () => new Blob([new Uint8Array(20 * 1024)], { type: 'application/octet-stream' }))
        const getGeneratedImageMetadata = vi.fn(async () => ({ success: true, size: 20 * 1024 }))
        renderCard({ mimeType: 'application/octet-stream', getGeneratedImageBlob, getGeneratedImageMetadata })

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Prepare download (20 KB)' })).toBeInTheDocument()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Prepare download (20 KB)' }))

        await waitFor(() => {
            expect(screen.getByRole('link', { name: 'Download file clip.mp4 (20 KB)' })).toHaveAttribute('download', 'clip.mp4')
            expect(screen.getByText('Download file (20 KB)')).toBeInTheDocument()
        })
    })

    it('localizes deferred media actions in Chinese', () => {
        renderCard({ mimeType: 'application/octet-stream', locale: 'zh-CN' })

        expect(screen.getByRole('button', { name: '加载文件' })).toBeInTheDocument()
    })

    it('localizes the video loading action in Chinese', () => {
        renderCard({ mimeType: 'video/mp4', locale: 'zh-CN' })

        expect(screen.getByRole('button', { name: '加载视频' })).toBeInTheDocument()
    })

    it('shows the file size before loading and uses the file label in Chinese', async () => {
        const getGeneratedImageBlob = vi.fn(async () => new Blob([new Uint8Array(20 * 1024)], { type: 'application/octet-stream' }))
        const getGeneratedImageMetadata = vi.fn(async () => ({ success: true, size: 20 * 1024 }))
        renderCard({ mimeType: 'application/octet-stream', locale: 'zh-CN', getGeneratedImageBlob, getGeneratedImageMetadata })

        await waitFor(() => {
            expect(screen.getByRole('button', { name: '加载文件（20 KB）' })).toBeInTheDocument()
        })
        fireEvent.click(screen.getByRole('button', { name: '加载文件（20 KB）' }))

        await waitFor(() => {
            expect(screen.getByRole('link', { name: '下载文件 clip.mp4（20 KB）' })).toBeInTheDocument()
            expect(screen.getByText('下载文件（20 KB）')).toBeInTheDocument()
        })
    })
})
