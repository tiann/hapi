import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import type { ApiClient } from '@/api/client'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'

function renderCard(options: {
    mimeType: string | null
    getGeneratedImageBlob?: ReturnType<typeof vi.fn>
}) {
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
    )

    return { getGeneratedImageBlob }
}

describe('GeneratedImageCard video fetch', () => {
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
