import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { CliOutputBlock } from '../src/components/CliOutputBlock'
import { I18nProvider } from '../src/lib/i18n-context'

const terminalPayload = `<command-name>node scripts/render-report --source ./fixtures/mobile-gutter-width.json --destination ./artifacts/mobile-preview.md</command-name><command-args>--format markdown
--include "한글 mixed-language summary"
--filter "status:active AND owner:platform"
--verbose</command-args><local-command-stdout>| 항목 | 상태 | 설명 |
| --- | --- | --- |
| mobile-gutter | 성공 | line numbers stay separate from code |
${Array.from({ length: 100 }, (_, index) => `row-${String(index + 1).padStart(3, '0')} | value`).join('\n')}</local-command-stdout>`

function TerminalGutterFixture() {
    return <div className="flex flex-col gap-4" data-testid="terminal-gutter-fixture"><CliOutputBlock text={terminalPayload} /></div>
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(<React.StrictMode><I18nProvider><TerminalGutterFixture /></I18nProvider></React.StrictMode>)
}
