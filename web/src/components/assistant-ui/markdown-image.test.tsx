import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'
import { MAX_MARKDOWN_IMAGE_BYTES } from '@/lib/markdown-file-assets'
import { ChatMarkdownImage } from './markdown-image'

function chatValue(api: ApiClient, metadataPath: string | null = '/home/ada/coding/hapi'): HappyChatContextValue {
    return {
        api,
        sessionId: 'session-1',
        metadata: metadataPath ? { path: metadataPath, host: 'local' } : null,
        terminalToolDisplayMode: 'compact',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'loaded',
    }
}

function renderImage(props: { src: string; alt: string; api?: ApiClient; metadataPath?: string | null }) {
    const api = props.api ?? ({ readSessionFile: vi.fn() } as unknown as ApiClient)
    return render(
        <I18nProvider>
            <HappyChatProvider value={chatValue(api, props.metadataPath)}>
                <ChatMarkdownImage src={props.src} alt={props.alt} />
            </HappyChatProvider>
        </I18nProvider>
    )
}

describe('ChatMarkdownImage', () => {
    it('loads a relative workspace image through the authenticated session API', async () => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src: 'images/chart.png', alt: 'Chart', api })

        await waitFor(() => expect(screen.getByRole('img', { name: 'Chart', hidden: false }).tagName).toBe('IMG'))
        expect(screen.getByRole('img', { name: 'Chart' })).toHaveAttribute('src', 'data:image/png;base64,cG5nLWJ5dGVz')
        expect(readSessionFile).toHaveBeenCalledWith('session-1', 'images/chart.png', MAX_MARKDOWN_IMAGE_BYTES)
    })

    it('renders a relative workspace image through the conversation Markdown renderer', async () => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        render(
            <I18nProvider>
                <HappyChatProvider value={chatValue(api)}>
                    <MarkdownRenderer content={'![Chart](images/chart.png)'} />
                </HappyChatProvider>
            </I18nProvider>
        )

        await waitFor(() => expect(screen.getByRole('img', { name: 'Chart' }).tagName).toBe('IMG'))
        expect(readSessionFile).toHaveBeenCalledWith('session-1', 'images/chart.png', MAX_MARKDOWN_IMAGE_BYTES)
    })

    it('loads reachable HTTPS images directly without reading a session file', () => {
        const readSessionFile = vi.fn()
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src: 'https://example.com/chart.png', alt: 'Remote chart', api })

        expect(screen.getByRole('img', { name: 'Remote chart' })).toHaveAttribute('src', 'https://example.com/chart.png')
        expect(readSessionFile).not.toHaveBeenCalled()
    })

    it('shows a fallback when a remote image fails to load', async () => {
        renderImage({ src: 'https://example.com/missing.png', alt: 'Missing remote' })

        const image = screen.getByRole('img', { name: 'Missing remote' })
        fireEvent.error(image)

        await waitFor(() => expect(screen.getByRole('img', { name: 'Missing remote' })).toHaveAttribute('data-hapi-markdown-image-fallback', 'true'))
    })

    it.each([
        ['../outside.png', 'parent traversal'],
        ['/etc/secret.png', 'outside absolute path'],
        ['data:image/png;base64,ZmFrZQ==', 'data URI'],
        ['file:///tmp/secret.png', 'file URI'],
    ])('does not read %s (%s)', (src) => {
        const readSessionFile = vi.fn()
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src, alt: 'Blocked image', api })

        expect(screen.getByRole('img', { name: 'Blocked image' })).toHaveAttribute('data-hapi-markdown-image-fallback', 'true')
        expect(readSessionFile).not.toHaveBeenCalled()
    })

    it('keeps an in-workspace absolute path behind the session file API', async () => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src: '/home/ada/coding/hapi/images/chart.png', alt: 'Absolute chart', api })

        await waitFor(() => expect(screen.getByRole('img', { name: 'Absolute chart' }).tagName).toBe('IMG'))
        expect(readSessionFile).toHaveBeenCalledWith('session-1', '/home/ada/coding/hapi/images/chart.png', MAX_MARKDOWN_IMAGE_BYTES)
    })
})
