import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { ToolCard } from '../src/components/ToolCard/ToolCard'
import { I18nProvider } from '../src/lib/i18n-context'
import type { ApiClient } from '../src/api/client'
import type { DecryptedMessage } from '../src/types/api'

// Recorded wire shape through the real normalization, reducer and ToolCard.
// No Hub, Runner, real agent or production session data is used here.
const variants = [
    { id: 'failed', title: 'Earlier server stopped during archival', output: { status: 'failed', exit_code: -1, duration_ms: 16_636_720 } },
    { id: 'unknown', title: 'Start and duration unavailable', output: { status: 'cancelled', exit_code: -1 } },
    { id: 'success', title: 'Completed command with native duration', output: { status: 'completed', exit_code: 0, duration_ms: 2500 } },
]

function Fixture() {
    return <main className="mx-auto max-w-3xl space-y-5 p-4 text-[var(--app-fg)]">
        <h1 className="text-xl font-semibold">Archived Codex session</h1>
        <p className="text-sm text-[var(--app-hint)]">Fixture verification · earlier command results received during shutdown</p>
        <p>Assistant: The requested work is complete.</p>
        {variants.map(({ id, title, output }) => {
            const message: DecryptedMessage = { id, seq: 1, localId: null, createdAt: 1_793_208_961_727,
                content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call-result', callId: id,
                    output: { type: 'exec_command_end', command: `node ${id}-server.js`, cwd: '/workspace/web', ...output } } } } }
            const normalized = normalizeDecryptedMessage(message)!
            const block = reduceChatBlocks([normalized], null).blocks[0]
            return <section key={id} data-testid={id} className="space-y-2">
                <h2 className="text-sm font-medium">{title}</h2>
                {block.kind === 'tool-call' && <ToolCard api={{} as ApiClient} sessionId="fixture" metadata={null}
                    terminalToolDisplayMode="detailed" disabled onDone={() => {}} block={block} />}
            </section>
        })}
    </main>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>)
