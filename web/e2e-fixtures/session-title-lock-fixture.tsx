import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { RenameSessionDialog } from '../src/components/RenameSessionDialog'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '../src/lib/toast-context'
import { SessionList } from '../src/components/SessionList'
import type { SessionSummary } from '../src/types/api'
import type { ApiClient } from '../src/api/client'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })

function Fixture() {
    const [sessions, setSessions] = useState([{ name: 'First session', locked: false }, { name: 'Second session', locked: false }])
    const [selected, setSelected] = useState(0)
    const [open, setOpen] = useState(false)
    const [showList, setShowList] = useState(false)
    const save = async (name: string | undefined, titleLocked?: boolean) => {
        setSessions(current => current.map((session, index) => index === selected ? { name: name ?? session.name, locked: !!titleLocked } : session))
    }
    return <>
        <button onClick={() => setShowList(true)}>Show session list</button>
        {sessions.map((session, index) => <div key={index}>
            <output data-testid={`session-${index}`}>{JSON.stringify(session)}</output>
            <button onClick={() => { setSelected(index); setOpen(true) }}>Rename {index + 1}</button>
        </div>)}
        <RenameSessionDialog isOpen={open} onClose={() => setOpen(false)} sessionId={String(selected)}
            currentName={sessions[selected].name} currentTitleLocked={sessions[selected].locked}
            onRename={save} onUpdateSummary={save} onSuggestTitle={async () => 'Generated title'} isPending={false} />
        {showList ? <SessionList
            sessions={sessions.map((session, index) => ({
                id: String(index), active: false, hasConversationContent: true, thinking: false,
                updatedAt: 1, activeAt: 1, pendingRequestsCount: 0, pendingRequestKinds: [],
                pendingRequests: [], backgroundTaskCount: 0, futureScheduledMessageCount: 0,
                metadata: { name: session.name, titleLocked: session.locked, path: '/fixture', flavor: 'codex' }
            } as SessionSummary))}
            selectedSessionId="0" onSelect={() => {}} onNewSession={() => {}} onRefresh={() => {}}
            isLoading={false} renderHeader={false}
            api={{ renameSession: async (id: string, name: string | undefined, titleLocked?: boolean) => {
                setSessions(current => current.map((session, index) => String(index) === id
                    ? { name: name ?? session.name, locked: titleLocked ?? session.locked } : session))
            } } as unknown as ApiClient}
        /> : null}
    </>
}

createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={queryClient}><I18nProvider><ToastProvider><Fixture /></ToastProvider></I18nProvider></QueryClientProvider>
)
