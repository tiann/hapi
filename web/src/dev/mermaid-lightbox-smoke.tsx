import { createRoot } from 'react-dom/client'
import { I18nProvider } from '@/lib/i18n-context'
import { MermaidDiagram } from '@/components/assistant-ui/mermaid-diagram'

const root = document.getElementById('root')
if (!root) {
    throw new Error('missing #root')
}

createRoot(root).render(
    <I18nProvider>
        <MermaidDiagram
            code={'flowchart LR\n  Click --> Lightbox\n  Lightbox --> Visible'}
            language="mermaid"
            components={{
                Pre: (props) => <pre {...props} />,
                Code: (props) => <code {...props} />,
            }}
        />
    </I18nProvider>,
)
