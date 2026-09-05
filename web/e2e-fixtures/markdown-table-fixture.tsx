import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { I18nProvider } from '../src/lib/i18n-context'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'

const TABLE_MARKDOWN = `# Repository activity

| Project | Stars | Language | Latest release | Maintainer | Notes |
| --- | ---: | --- | --- | --- | --- |
| HAPI | 128 | TypeScript | 0.28.0 | Local-first team | Remote control for coding agents |
| HAPI, local-first | 42 | TypeScript | 0.27.3 | Community | A deliberately long description for horizontal table scrolling |
| Example | 7 | Rust | 1.2.0 | Open source | Stable fixture row |`

const NEAR_BOTTOM_VERTICAL_TABLE_MARKDOWN = `# Near bottom table

| Item | Status |
| --- | --- |
${Array.from({ length: 14 }, (_, index) => `| Item ${index + 1} | Ready |`).join('\n')}`

function MarkdownTableFixture() {
    const query = new URLSearchParams(window.location.search)
    const content = query.has('near-bottom-scroll')
        ? NEAR_BOTTOM_VERTICAL_TABLE_MARKDOWN
        : TABLE_MARKDOWN

    return (
        <HappyChatProvider value={{ sessionTitle: 'Table filename fixture' } as HappyChatContextValue}>
            <main data-testid="markdown-table-fixture">
                <MarkdownRenderer standalone content={content} />
            </main>
        </HappyChatProvider>
    )
}

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <I18nProvider>
                <MarkdownTableFixture />
            </I18nProvider>
        </React.StrictMode>,
    )
}
