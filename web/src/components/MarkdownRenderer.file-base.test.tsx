import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'

const readSessionFile = vi.hoisted(() => vi.fn(async () => ({ success: true, content: 'iVBORw0K' })))
const listSessionDirectory = vi.hoisted(() => vi.fn(async () => ({
    success: true,
    entries: [
        { name: 'page-001.png', type: 'file', size: 1024 },
        { name: 'huge.png', type: 'file', size: 50 * 1024 * 1024 },
    ],
})))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { readSessionFile, listSessionDirectory } }),
}))

const markdown = [
    '[Sibling](error-notes.md)',
    '[Escape](../../outside.md)',
    '[Session](./sessions/abc-def)',
    '![Local](images/page-001.png)',
    '![Huge](images/huge.png)',
    '![Remote](https://example.com/image.png)',
].join('\n\n')

function renderPreview(filePath: string, workspacePath: string | null = null, fileSearch = {}) {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <I18nProvider>
                <MarkdownRenderer
                    content={markdown}
                    standalone
                    sessionId="session-1"
                    filePath={filePath}
                    workspacePath={workspacePath}
                    fileSearch={fileSearch}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('MarkdownRenderer standalone file base', () => {
    it('resolves relative links and images against the Markdown file directory', async () => {
        renderPreview('docs/notes-01.md', null, { tab: 'directories' })

        const sibling = screen.getByText('Sibling').closest('a')
        const search = new URLSearchParams({ path: encodeBase64('docs/error-notes.md'), tab: 'directories' })
        expect(sibling).toHaveAttribute('href', `/sessions/session-1/file?${search.toString()}`)
        expect(screen.getByText('Escape').closest('a')).toBeNull()
        expect(screen.getByText('Session').closest('a')?.getAttribute('href')).toMatch(/\/sessions\/abc-def$/)

        await waitFor(() => {
            expect(screen.getByAltText('Local')).toHaveAttribute('src', 'data:image/png;base64,iVBORw0K')
        })
        expect(listSessionDirectory).toHaveBeenCalledWith('session-1', 'docs/images')
        expect(readSessionFile).toHaveBeenCalledWith('session-1', 'docs/images/page-001.png')
        expect(readSessionFile).not.toHaveBeenCalledWith('session-1', 'docs/images/huge.png')
        expect(screen.getByAltText('Huge')).not.toHaveAttribute('src')
        expect(screen.getByAltText('Remote')).toHaveAttribute('src', 'https://example.com/image.png')
    })

    it('keeps absolute-base links outside the workspace inert', () => {
        renderPreview('/home/ada/project/docs/notes-01.md', '/home/ada/project')

        const search = new URLSearchParams({ path: encodeBase64('/home/ada/project/docs/error-notes.md') })
        expect(screen.getByText('Sibling').closest('a')).toHaveAttribute('href', `/sessions/session-1/file?${search.toString()}`)
        expect(screen.getByText('Escape').closest('a')).toBeNull()
    })
})
