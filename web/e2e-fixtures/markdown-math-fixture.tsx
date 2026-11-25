import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'

const SAMPLE_MARKDOWN = [
    '# Markdown math fixture',
    '',
    String.raw`Inline: \(x^2 + y^2\)`,
    '',
    String.raw`\[`,
    String.raw`\lim_{x\to 0}\frac{\sin x}{x}=1`,
    String.raw`\]`,
    '',
    '```latex',
    '\\[x^2\\]',
    '```',
].join('\n')

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <I18nProvider>
                <div data-testid="markdown-math-fixture">
                    <MarkdownRenderer content={SAMPLE_MARKDOWN} standalone />
                </div>
            </I18nProvider>
        </React.StrictMode>
    )
}
