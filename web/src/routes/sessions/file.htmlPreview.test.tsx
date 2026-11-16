import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'
import FilePage from './file'

const readSessionFileMock = vi.hoisted(() => vi.fn())
const files: Record<string, string> = {
    'designs/index.html': '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"></head><body><h1>Hi</h1></body></html>',
    'designs/tokens.css': 'h1 { color: red }'
}

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => ({ path: encodeBase64('designs/index.html'), staged: undefined })
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {
            getGitDiffFile: async () => ({ success: true, stdout: '' }),
            readSessionFile: readSessionFileMock,
            listSessionDirectory: async (_sessionId: string, path?: string) => (
                path === 'designs'
                    ? { success: true, entries: [{ name: 'index.html', type: 'file' }, { name: 'tokens.css', type: 'file' }] }
                    : { success: false, error: 'not found' }
            )
        }
    })
}))

vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))

vi.mock('@/lib/shiki', () => ({
    langAlias: {},
    useShikiHighlighter: (content: string) => content
}))

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <FilePage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('FilePage HTML preview', () => {
    beforeEach(() => {
        readSessionFileMock.mockReset()
        readSessionFileMock.mockImplementation(async (_sessionId: string, path: string) => (
            path in files
                ? { success: true, content: encodeBase64(files[path]!), size: files[path]!.length }
                : { success: false, error: 'not found' }
        ))
        window.localStorage.clear()
    })

    it('renders HTML in a script-only sandboxed iframe with local assets inlined, and toggles to source', async () => {
        renderPage()

        const iframe = await waitFor(() => {
            const element = document.querySelector('iframe')
            expect(element).not.toBeNull()
            return element!
        })
        expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
        expect(iframe.getAttribute('srcdoc')).toContain('<style>h1 { color: red }</style>')
        expect(iframe.getAttribute('srcdoc')).toContain('<h1>Hi</h1>')
        expect(readSessionFileMock).toHaveBeenCalledWith('session-1', 'designs/tokens.css', expect.any(Number))

        fireEvent.click(screen.getByRole('button', { name: 'Source' }))
        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('<h1>Hi</h1>')
        })
        expect(document.querySelector('iframe')).toBeNull()
    })

    it('opens the preview in a new tab that still sandboxes the page', async () => {
        const popupDocument = document.implementation.createHTMLDocument('')
        const popup = { document: popupDocument, opener: window } as unknown as Window
        const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup)
        renderPage()

        fireEvent.click(await screen.findByRole('button', { name: 'Open in new window' }))

        expect(openSpy).toHaveBeenCalledWith('', '_blank')
        expect(popup.opener).toBeNull()
        expect(popupDocument.title).toBe('index.html')
        const frame = popupDocument.querySelector('iframe')
        expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
        expect(frame?.srcdoc).toContain('<style>h1 { color: red }</style>')
        expect(popupDocument.querySelectorAll('script')).toHaveLength(0)
        openSpy.mockRestore()
    })
})
