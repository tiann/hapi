/*
 * Standalone Vite-served fixture for the file-pane markdown Source |
 * Preview Playwright smoke. Mounts the same toggle + MarkdownRenderer
 * path as `file.tsx` without the HAPI auth / git / socket stack.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Outlet, createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { ApiClient } from '../src/api/client'
import '../src/index.css'
import { AppContextProvider } from '../src/lib/app-context'
import { I18nProvider } from '../src/lib/i18n-context'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import {
    getInitialMarkdownPreviewMode,
    persistMarkdownPreviewMode,
    type MarkdownPreviewMode,
} from '../src/lib/file-markdown-preview'
import { useTranslation } from '../src/lib/use-translation'

const SAMPLE_MARKDOWN = `# Teams and channels

[Related note](error-notes.md)

[Session reference](/sessions/session-42)

![Page 001](images/page-001.png)

| Channel | Purpose |
| --- | --- |
| general | Day-to-day coordination |
| incidents | Outage response |

\`\`\`ts
export const ok = true
\`\`\`

> Preview uses the same markdown pipeline as chat.
`

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const FILE_PREVIEW_API = {
    readSessionFile: async (_sessionId: string, path: string, _maxBytes?: number) => ({
        success: true,
        content: path === 'notes/images/page-001.png' ? ONE_PIXEL_PNG : '',
        size: path === 'notes/images/page-001.png' ? 68 : 0,
    }),
    listSessionDirectory: async (_sessionId: string, path?: string) => ({
        success: true,
        entries: path === 'notes/images'
            ? [{ name: 'page-001.png', type: 'file' as const, size: 68 }]
            : [],
    }),
} as unknown as ApiClient

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { retry: false },
    },
})

function FileMarkdownPreviewFixture() {
    const { t } = useTranslation()
    const [mode, setMode] = React.useState<MarkdownPreviewMode>(() => getInitialMarkdownPreviewMode())
    const showSource = mode === 'source'

    const setMarkdownPreviewMode = (next: MarkdownPreviewMode) => {
        setMode(next)
        persistMarkdownPreviewMode(next)
    }

    return (
        <div data-testid="file-md-preview-fixture" className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    data-testid="markdown-mode-source"
                    onClick={() => setMarkdownPreviewMode('source')}
                    className={`rounded px-3 py-1 text-xs font-semibold ${showSource ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                >
                    {t('file.page.tab.source')}
                </button>
                <button
                    type="button"
                    data-testid="markdown-mode-preview"
                    onClick={() => setMarkdownPreviewMode('preview')}
                    className={`rounded px-3 py-1 text-xs font-semibold ${!showSource ? 'bg-[var(--app-button)] text-[var(--app-button-text)] opacity-80' : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'}`}
                >
                    {t('file.page.tab.preview')}
                </button>
            </div>
            {showSource ? (
                <pre
                    data-testid="markdown-source-view"
                    className="overflow-auto rounded-md bg-[var(--app-code-bg)] p-3 text-xs font-mono"
                >
                    <code>{SAMPLE_MARKDOWN}</code>
                </pre>
            ) : (
                <div data-testid="markdown-preview-view" className="markdown-content">
                    <MarkdownRenderer
                        content={SAMPLE_MARKDOWN}
                        standalone
                        sessionId="session-1"
                        filePath="notes/notes-01.md"
                        workspacePath="/workspace"
                    />
                </div>
            )}
        </div>
    )
}

function FileTargetRoute() {
    return <div data-testid="file-target-route">Opened sibling Markdown file</div>
}

function SessionTargetRoute() {
    return <div data-testid="session-target-route">Opened session reference</div>
}

const rootRoute = createRootRoute({ component: Outlet })
const fixtureRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: FileMarkdownPreviewFixture,
})
const fileTargetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId/file',
    component: FileTargetRoute,
})
const sessionTargetRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/sessions/$sessionId',
    component: SessionTargetRoute,
})
const router = createRouter({
    routeTree: rootRoute.addChildren([fixtureRoute, fileTargetRoute, sessionTargetRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
})

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <QueryClientProvider client={queryClient}>
                <AppContextProvider value={{ api: FILE_PREVIEW_API, token: 'fixture-token', baseUrl: window.location.origin }}>
                    <I18nProvider>
                        <RouterProvider router={router} />
                    </I18nProvider>
                </AppContextProvider>
            </QueryClientProvider>
        </React.StrictMode>
    )
}
