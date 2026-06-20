/*
 * Standalone Vite-served fixture for the file-pane markdown Source |
 * Preview Playwright smoke. Mounts the same toggle + MarkdownRenderer
 * path as `file.tsx` without the HAPI auth / git / socket stack.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import {
    getInitialMarkdownPreviewMode,
    persistMarkdownPreviewMode,
    type MarkdownPreviewMode,
} from '../src/lib/file-markdown-preview'
import { useTranslation } from '../src/lib/use-translation'

const SAMPLE_MARKDOWN = `# Teams and channels

| Channel | Purpose |
| --- | --- |
| general | Day-to-day coordination |
| incidents | Outage response |

\`\`\`ts
export const ok = true
\`\`\`

> Preview uses the same markdown pipeline as chat.
`

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
                    <MarkdownRenderer content={SAMPLE_MARKDOWN} standalone />
                </div>
            )}
        </div>
    )
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <I18nProvider>
                <FileMarkdownPreviewFixture />
            </I18nProvider>
        </React.StrictMode>
    )
}
