import { useCallback, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { useMentionInactiveCollapsed } from '../src/hooks/useMentionInactiveCollapsed'
import type { SuggestionRequestContext } from '../src/hooks/useActiveSuggestions'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { createDeferredSuggestions } from '../src/lib/deferredSuggestions'
import { I18nProvider } from '../src/lib/i18n-context'
import { buildSessionMentionSuggestions } from '../src/lib/sessionMentionSuggestions'
import type { Session, SessionSummary } from '../src/types/api'
import '../src/index.css'

const session = { id: 'current', active: true, thinking: false } as Session
const sessions = [
    { id: 'active-peer', active: true, updatedAt: 100, hasConversationContent: true,
        metadata: { name: 'Project active', path: '/work/project', lifecycleState: 'running' } },
    { id: 'archived-peer', active: false, updatedAt: 200, hasConversationContent: true,
        metadata: { name: 'Project archived', path: '/work/project', lifecycleState: 'archived' } },
] as SessionSummary[]

function Fixture() {
    const { mentionInactiveCollapsed, setMentionInactiveCollapsed } = useMentionInactiveCollapsed()
    const deferred = useMemo(() => createDeferredSuggestions(), [])
    const suggest = useCallback(async (query: string, context: SuggestionRequestContext) => {
        if (!query.startsWith('@')) return []
        const local = buildSessionMentionSuggestions({ sessions, query: query.slice(1),
            resolveMachineLabel: () => '', inactiveCollapsed: mentionInactiveCollapsed,
            inactiveLabel: 'Inactive sessions', toggleInactive: () => setMentionInactiveCollapsed(!mentionInactiveCollapsed) })
        return deferred(query, local, async () => [{ key: 'file:project.ts', text: '@"project.ts"', label: '@project.ts' }], context)
    }, [deferred, mentionInactiveCollapsed, setMentionInactiveCollapsed])
    const runtime = useHappyRuntime({ session, blocks: [], messagesVersion: 0, historyVersion: 0,
        isSending: false, isRunning: false, onSendMessage: () => {}, onAbort: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}>
        <main className="mx-auto max-w-3xl pt-80">
            <HappyComposer agentFlavor="codex" active autocompleteSuggestions={suggest} />
        </main>
    </AssistantRuntimeProvider>
}

createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>)
