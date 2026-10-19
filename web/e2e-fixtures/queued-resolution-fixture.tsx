import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider, useLocalRuntime, type ChatModelAdapter } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import '../src/index.css'
import { ApiClient } from '../src/api/client'
import { QueuedMessagesBar } from '../src/components/AssistantChat/QueuedMessagesBar'
import { I18nProvider } from '../src/lib/i18n-context'
import { ToastProvider } from '../src/lib/toast-context'
import { appendOptimisticMessage, clearMessageWindow, getMessageWindowState, ingestIncomingMessages, markMessagesConsumed } from '../src/lib/message-window-store'
import type { DecryptedMessage } from '../src/types/api'

// Only API responses are mocked by Playwright. The component, mutation hooks,
// API client, message store, runtime, translations and dialog are production code.
const kind = new URLSearchParams(window.location.search).get('kind') ?? 'unknown'
document.documentElement.dataset.theme = localStorage.getItem('hapi-lang') === 'zh-CN' ? 'dark' : 'light'
const sessionId = 'queued-resolution-fixture'
const message: DecryptedMessage = {
    id: 'queued-resolution-message',
    localId: 'queued-resolution-local',
    seq: 1,
    createdAt: Date.now(),
    invokedAt: null,
    status: 'queued',
    scheduledAt: kind === 'scheduled' ? Date.now() + 3_600_000 : null,
    ...(kind === 'unknown' ? { deliveryState: 'indeterminate' as const, queueDismissed: true } : {}),
    content: { role: 'user', content: { type: 'text', text: 'Please continue the previous task after the restart.' } },
}
clearMessageWindow(sessionId)
appendOptimisticMessage(sessionId, message)

declare global {
    interface Window {
        __queuedResolutionFixture: { getMessages: () => DecryptedMessage[]; receiveConsumption: () => void; pendingMutations: () => number }
    }
}
window.__queuedResolutionFixture = {
    getMessages: () => getMessageWindowState(sessionId).messages,
    pendingMutations: () => queryClient.isMutating(),
    receiveConsumption: () => {
        markMessagesConsumed(sessionId, [message.localId!], 2000)
        ingestIncomingMessages(sessionId, [{ ...message, invokedAt: 2000, status: 'sent', deliveryState: undefined }])
    },
}

const api = new ApiClient('')
const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
const adapter: ChatModelAdapter = { async *run() {} }

function Fixture() {
    const runtime = useLocalRuntime(adapter)
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                        <main className="mx-auto flex min-h-dvh w-full max-w-3xl flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
                            <header className="border-b border-[var(--app-border)] p-4">Queued message recovery</header>
                            <div className="flex-1 p-4 text-[var(--app-hint)]">Codex</div>
                            <QueuedMessagesBar sessionId={sessionId} api={api} canAbandon
                                pendingSchedule={null} pendingScheduleRevision={0} />
                            <footer className="p-3">
                                <textarea aria-label="Message draft" placeholder="Message" className="w-full rounded-xl bg-[var(--app-secondary-bg)] p-3" />
                            </footer>
                        </main>
                    </ToastProvider>
                </I18nProvider>
            </QueryClientProvider>
        </AssistantRuntimeProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Fixture />)
