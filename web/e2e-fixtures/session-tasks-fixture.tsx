import { createRoot } from 'react-dom/client'
import { extractSessionTodosFromMessageContent } from '../../hub/src/sync/todos'
import { buildSessionStatusData } from '../src/chat/sessionStatus'
import { SessionStatusPanel } from '../src/components/SessionStatusPanel'
import { I18nProvider } from '../src/lib/i18n-context'
import '../src/index.css'

const tasks = extractSessionTodosFromMessageContent({ role: 'agent', content: { type: 'output', data: {
    type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'ExitPlanMode', input: { plan: '- [x] Inspect\n- [ ] Implement' } }
    ] },
} } })
const status = buildSessionStatusData({ goal: null, tasks, blocks: [] })
if (!status) throw new Error('Expected a session task snapshot')

createRoot(document.getElementById('root')!).render(
    <I18nProvider>
        <main className="relative mx-auto mt-4 max-w-md">
            <SessionStatusPanel data={status} />
        </main>
    </I18nProvider>
)
