import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function renderImage(props: {
    src: string
    alt: string
    api?: ApiClient
    metadataPath?: string | null
    onLoad?: React.ReactEventHandler<HTMLImageElement>
    onError?: React.ReactEventHandler<HTMLImageElement>
}) {
    const api = props.api ?? ({ readSessionFile: vi.fn() } as unknown as ApiClient)
    return render(
        <I18nProvider>
            <HappyChatProvider value={chatValue(api, props.metadataPath)}>
                <ChatMarkdownImage src={props.src} alt={props.alt} onLoad={props.onLoad} onError={props.onError} />
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

    it('wraps a local image in the shared preview trigger while it loads', async () => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src: 'images/chart.png', alt: 'Chart', api })

        await waitFor(() => expect(screen.getByRole('img', { name: 'Chart' }).tagName).toBe('IMG'))
        const image = screen.getByRole('img', { name: 'Chart' })
        const trigger = screen.getByRole('button', { name: /chart/i })
        expect(trigger).toBeDisabled()
        expect(trigger).toHaveAttribute('title', 'Loading image')
        expect(trigger).toHaveAttribute('data-image-preview-file-name', 'chart.png')
        expect(trigger).toHaveAttribute('data-image-preview-file-size', '9')
        expect(image).toHaveAttribute('src', 'data:image/png;base64,cG5nLWJ5dGVz')
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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

    it('does not nest the image preview trigger inside a Markdown link', async () => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        render(
            <I18nProvider>
                <HappyChatProvider value={chatValue(api)}>
                    <MarkdownRenderer content={'[![Linked chart](images/chart.png)](report.md)'} />
                </HappyChatProvider>
            </I18nProvider>
        )

        await waitFor(() => expect(screen.getByRole('img', { name: 'Linked chart' }).tagName).toBe('IMG'))
        const trigger = screen.getByRole('button', { name: /linked chart/i })
        expect(trigger.closest('a')).toBeNull()

        fireEvent.load(screen.getByRole('img', { name: 'Linked chart' }))
        fireEvent.click(trigger)
        const dialog = screen.getByRole('dialog', { name: 'Linked chart' })
        fireEvent.click(within(dialog).getByTitle('Zoom in', { exact: true }))
        expect(screen.getByRole('dialog', { name: 'Linked chart' })).toBeInTheDocument()
        fireEvent.click(within(dialog).getByTitle('Close', { exact: true }))
        expect(screen.queryByRole('dialog', { name: 'Linked chart' })).not.toBeInTheDocument()
    })

    it('preserves text navigation in mixed image and text links', async () => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        render(
            <I18nProvider>
                <HappyChatProvider value={chatValue(api)}>
                    <MarkdownRenderer content={'[![Linked chart](images/chart.png) Open report](report.md)'} />
                </HappyChatProvider>
            </I18nProvider>
        )

        await waitFor(() => expect(screen.getByRole('img', { name: 'Linked chart' }).tagName).toBe('IMG'))
        const trigger = screen.getByRole('button', { name: /linked chart/i })
        const reportLink = screen.getByText('Open report').closest('a')
        expect(trigger.closest('a')).toBeNull()
        expect(reportLink).not.toBeNull()
        expect(reportLink).toHaveAttribute('href', '/sessions/session-1/file?path=cmVwb3J0Lm1k&origin=chat')
    })

    it.each([
        ['strong', '[**![Nested chart](images/chart.png) Open report**](report.md)', 'STRONG'],
        ['emphasis', '[*![Nested chart](images/chart.png) Open report*](report.md)', 'EM'],
    ])('preserves text navigation inside %s wrappers', async (_name, content, wrapperTag) => {
        const readSessionFile = vi.fn(async () => ({
            success: true,
            content: encodeBase64('png-bytes'),
            size: 9,
        }))
        const api = { readSessionFile } as unknown as ApiClient

        render(
            <I18nProvider>
                <HappyChatProvider value={chatValue(api)}>
                    <MarkdownRenderer content={content} />
                </HappyChatProvider>
            </I18nProvider>
        )

        await waitFor(() => expect(screen.getByRole('img', { name: 'Nested chart' }).tagName).toBe('IMG'))
        const trigger = screen.getByRole('button', { name: /nested chart/i })
        const reportText = screen.getByText('Open report')
        const reportLink = reportText.closest('a')
        expect(trigger.closest('a')).toBeNull()
        expect(reportLink).not.toBeNull()
        expect(reportLink?.querySelector(wrapperTag)).not.toBeNull()
    })

    it('loads reachable HTTPS images directly without reading a session file', () => {
        const readSessionFile = vi.fn()
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src: 'https://example.com/chart.png', alt: 'Remote chart', api })

        expect(screen.getByRole('img', { name: 'Remote chart' })).toHaveAttribute('src', 'https://example.com/chart.png')
        expect(readSessionFile).not.toHaveBeenCalled()
    })

    it('opens a successfully loaded remote image in the shared fullscreen preview', async () => {
        const readSessionFile = vi.fn()
        const api = { readSessionFile } as unknown as ApiClient

        renderImage({ src: 'https://example.com/chart.png', alt: 'Remote chart', api })

        const image = screen.getByRole('img', { name: 'Remote chart' })
        const trigger = screen.getByRole('button', { name: /remote chart/i })
        expect(trigger).toBeDisabled()
        expect(image).toHaveAttribute('referrerpolicy', 'no-referrer')

        fireEvent.load(image)
        expect(trigger).toBeEnabled()
        fireEvent.click(trigger)

        const dialog = screen.getByRole('dialog', { name: 'Remote chart' })
        expect(within(dialog).getByRole('img', { name: 'Remote chart' }))
            .toHaveAttribute('referrerpolicy', 'no-referrer')
        expect(dialog).toHaveTextContent('chart.png')
        expect(readSessionFile).not.toHaveBeenCalled()
    })

    it('shows a fallback when a remote image fails to load', async () => {
        const onError = vi.fn()
        renderImage({ src: 'https://example.com/missing.png', alt: 'Missing remote', onError })

        const image = screen.getByRole('img', { name: 'Missing remote' })
        fireEvent.error(image)

        await waitFor(() => expect(screen.getByRole('img', { name: 'Missing remote' })).toHaveAttribute('data-hapi-markdown-image-fallback', 'true'))
        expect(onError).toHaveBeenCalledTimes(1)
        expect(screen.queryByRole('button', { name: /missing remote/i })).not.toBeInTheDocument()
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
