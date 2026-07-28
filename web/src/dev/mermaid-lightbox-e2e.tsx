import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@/lib/i18n-context'
import { MermaidDiagram } from '@/components/assistant-ui/mermaid-diagram'
import {
    MERMAID_LIGHTBOX_CASE_IDS,
    MERMAID_LIGHTBOX_CASES,
    type MermaidLightboxCaseId,
} from '@/dev/mermaid-lightbox-cases'

const root = document.getElementById('root')
if (!root) {
    throw new Error('missing #root')
}

const params = new URLSearchParams(window.location.search)
const caseId = params.get('case') as MermaidLightboxCaseId | null
const code = caseId && caseId in MERMAID_LIGHTBOX_CASES
    ? MERMAID_LIGHTBOX_CASES[caseId]
    : MERMAID_LIGHTBOX_CASES.flowchart

document.title = `Mermaid lightbox e2e: ${caseId ?? 'flowchart'}`

createRoot(root).render(
    <I18nProvider>
        <div data-mermaid-e2e-case={caseId ?? 'flowchart'}>
            <MermaidDiagram
                code={code}
                language="mermaid"
                components={{
                    Pre: (props) => <pre {...props} />,
                    Code: (props) => <code {...props} />,
                }}
            />
        </div>
    </I18nProvider>,
)

// Expose case list for Playwright discovery without importing TS in Node.
;(window as Window & { __MERMAID_E2E_CASES__?: string[] }).__MERMAID_E2E_CASES__ = [...MERMAID_LIGHTBOX_CASE_IDS]
