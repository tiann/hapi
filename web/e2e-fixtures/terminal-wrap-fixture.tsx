import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { CliOutputBlock } from '../src/components/CliOutputBlock'
import { DiffView } from '../src/components/DiffView'
import { ToolCard } from '../src/components/ToolCard/ToolCard'
import { I18nProvider } from '../src/lib/i18n-context'
import type { ApiClient } from '../src/api/client'
import type { ToolCallBlock } from '../src/chat/types'

const terminalPayload = `<command-name>node scripts/render-report --source ./fixtures/mobile-terminal-wrap-fidelity-with-a-deliberately-long-path-and-unbroken-identifier.json --destination ./artifacts/mobile-preview.md</command-name><command-args>--format markdown
--include "한글 mixed-language summary"
--filter "status:active AND owner:platform"
--verbose</command-args><local-command-stdout>| 항목 | 상태 | 설명 |
| --- | --- | --- |
| mobile-wrap | 성공 | 한글과 English text are both preserved |

long stdout text wraps naturally at the mobile code surface without changing source whitespace
${Array.from({ length: 100 }, (_, index) => `row-${String(index + 1).padStart(3, '0')} | value`).join('\n')}</local-command-stdout>`

const codexDiffBlock: ToolCallBlock = {
    kind: 'tool-call', id: 'fixture-codex-diff', localId: null, createdAt: 1_000,
    tool: {
        id: 'fixture-codex-diff', name: 'CodexDiff', state: 'completed',
        input: { unified_diff: 'diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-before\n+after with a deliberately long value that must wrap in the CodexDiff ToolCard' },
        createdAt: 1_000, startedAt: 1_000, completedAt: 1_100, execStartedAt: null, execCompletedAt: null, description: null,
    }, children: [],
}

function TerminalWrapFixture() {
    return (
        <div className="flex flex-col gap-4" data-testid="terminal-wrap-fixture">
            <CliOutputBlock text={terminalPayload} />
            <div data-testid="diff-preview">
                <DiffView
                    oldString="const status = 'before'\n"
                    newString="const status = 'after with a deliberately long value that must use the shared global wrap preference'\n"
                    filePath="src/mobile-terminal.ts"
                />
            </div>
            <div data-testid="diff-inline">
                <DiffView
                    oldString="const status = 'before'\n"
                    newString="const status = 'after with a deliberately long value that must wrap in the standalone inline surface'\n"
                    filePath="src/standalone-inline.ts"
                    variant="inline"
                    size="comfortable"
                />
            </div>
            <div data-testid="toolcard-codex-diff">
                <ToolCard api={{} as ApiClient} sessionId="fixture-session" metadata={null} terminalToolDisplayMode="detailed" disabled={false} onDone={() => {}} block={codexDiffBlock} />
            </div>
        </div>
    )
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <I18nProvider>
                <TerminalWrapFixture />
            </I18nProvider>
        </React.StrictMode>
    )
}
