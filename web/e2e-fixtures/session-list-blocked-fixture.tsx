import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import type { SessionSummary } from '../src/types/api'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import { SessionList } from '../src/components/SessionList'

/**
 * Fleet-scale session list for the #1717 blocked chrome.
 *
 * Deliberately seeds enough projects and rows that the blocked sessions fall
 * outside the initial viewport — the off-viewport case is the whole point of
 * the header pill, and a three-row fixture would prove nothing.
 */
// Relative to the wall clock on purpose: the loud-vs-stale split is measured
// against "now", so a frozen epoch would make every seeded footer stale.
const NOW = Date.now()
const HOUR = 60 * 60 * 1000

const PROJECTS = [
    'hapi', 'cli', 'hub', 'web', 'shared',
    'relay', 'runner', 'protocol', 'website', 'docs',
    'android', 'ios', 'telemetry', 'billing', 'infra',
    'scratch', 'sandbox', 'bench', 'archive', 'tooling',
    'gateway', 'scheduler', 'importer', 'search'
]

function base(id: string, index: number, project: string): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: NOW - index * 7 * 60_000,
        metadata: {
            path: `/home/heavygee/coding/${project}`,
            name: `${project} · task ${index + 1}`,
            flavor: index % 3 === 0 ? 'claude' : index % 3 === 1 ? 'codex' : 'gemini'
        },
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        lastNotify: null,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null
    }
}

const SESSIONS: SessionSummary[] = []
let counter = 0
for (const project of PROJECTS) {
    for (let i = 0; i < 4; i += 1) {
        SESSIONS.push(base(`${project}-${i}`, counter, project))
        counter += 1
    }
}

// A working agent and an idle-connected agent, so the blocked treatment has to
// hold its own against the rest of the list's attention vocabulary rather than
// being the only thing on screen.
SESSIONS[1] = { ...SESSIONS[1]!, active: true, thinking: true }
SESSIONS[3] = { ...SESSIONS[3]!, active: true }

// Prompt-parked agents. These count as blocked too: the operator cannot let
// them proceed without answering, which is the same problem as a self-reported
// blocked footer.
SESSIONS[2] = {
    ...SESSIONS[2]!,
    active: true,
    pendingRequestsCount: 1,
    pendingRequestKinds: ['permission'],
    pendingRequests: [{ id: 'r1', kind: 'permission', tool: 'Bash', since: NOW - 2 * 60_000 }]
}
SESSIONS[61] = {
    ...SESSIONS[61]!,
    active: true,
    pendingRequestsCount: 1,
    pendingRequestKinds: ['input'],
    pendingRequests: [{ id: 'r2', kind: 'input', tool: 'AskUserQuestion', since: NOW - 12 * 60_000 }]
}
// Cursor's plan-approval prompt — same class of ask as Claude's ExitPlanMode.
SESSIONS[70] = {
    ...SESSIONS[70]!,
    active: true,
    pendingRequestsCount: 1,
    pendingRequestKinds: ['input'],
    pendingRequests: [{ id: 'r3', kind: 'input', tool: 'CursorCreatePlan', since: NOW - 20 * 60_000 }]
}

// The rest of the vocabulary the operator counts as blocking.
SESSIONS[36] = {
    ...SESSIONS[36]!,
    lastNotify: { status: 'needs_decision', at: NOW - 25 * 60_000, note: 'pick auth approach' }
}
SESSIONS[42] = {
    ...SESSIONS[42]!,
    lastNotify: { status: 'needs_review', at: NOW - 90 * 60_000, note: 'diff ready for review' }
}
SESSIONS[55] = {
    ...SESSIONS[55]!,
    lastNotify: { status: 'failed', at: NOW - 8 * 60_000, note: 'migration threw on v29' }
}
// Non-contract but the most-emitted waiting status in the wild (92 uses).
SESSIONS[66] = {
    ...SESSIONS[66]!,
    lastNotify: { status: 'pending', at: NOW - 35 * 60_000, note: 'awaiting operator call' }
}
// Must NOT light up — non-contract synonym for done.
SESSIONS[74] = {
    ...SESSIONS[74]!,
    lastNotify: { status: 'completed', at: NOW - 4 * 60_000, note: null }
}

// Blocked rows, deliberately scattered deep into the list.
SESSIONS[14] = {
    ...SESSIONS[14]!,
    active: true,
    lastNotify: { status: 'blocked', at: NOW - 5 * 60_000, note: 'needs prod DB credentials' }
}
SESSIONS[29] = {
    ...SESSIONS[29]!,
    lastNotify: { status: 'blocked', at: NOW - 40 * 60_000, note: 'upstream PR review required' }
}
SESSIONS[47] = {
    ...SESSIONS[47]!,
    lastNotify: { status: 'stalled', at: NOW - 3 * HOUR, note: 'cannot reproduce the failing test' }
}
// Past the loud window — must demote to muted rather than alarm forever.
SESSIONS[52] = {
    ...SESSIONS[52]!,
    lastNotify: { status: 'blocked', at: NOW - 40 * HOUR, note: 'abandoned three days ago' }
}

const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
})

function Fixture() {
    // Test seam: let the spec push a NEW blocker in so the arrival alert can be
    // observed. Arrival is the whole point — a static fixture can only ever
    // show the resting state.
    const [extra, setExtra] = React.useState<SessionSummary[]>([])
    React.useEffect(() => {
        ;(window as unknown as { __addBlocker?: () => void }).__addBlocker = () => {
            setExtra([{
                ...base('late-blocker', 0, 'hapi'),
                lastNotify: { status: 'blocked', at: Date.now(), note: 'just now' }
            }])
        }
    }, [])
    return (
        <div style={{ height: '100vh', width: '420px', display: 'flex', flexDirection: 'column' }}>
            <SessionList
                sessions={[...extra, ...SESSIONS]}
                selectedSessionId={null}
                onSelect={() => {}}
                onNewSession={() => {}}
                onRefresh={() => {}}
                isLoading={false}
                api={null}
            />
        </div>
    )
}

const root = document.getElementById('root')
if (root) {
    ReactDOM.createRoot(root).render(
        <React.StrictMode>
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <Fixture />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        </React.StrictMode>
    )
}
