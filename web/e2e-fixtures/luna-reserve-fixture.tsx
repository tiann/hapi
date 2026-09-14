import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '../src/lib/i18n-context'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { getSessionModelLabel } from '../src/lib/sessionModelLabel'
import '../src/index.css'

const queryClient = new QueryClient()
function Fixture() {
    const [model, setModel] = useState('gpt-6-astra')
    const [pending, setPending] = useState<string | null>(null)
    const [eligible, setEligible] = useState(false)
    const [reads, setReads] = useState(0)
    const [sends, setSends] = useState(0)
    const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => { setSends(n => n + 1) } })
    return <AssistantRuntimeProvider runtime={runtime}>
        <main className="mx-auto flex h-screen max-w-3xl flex-col p-3">
            <div data-testid="model">{getSessionModelLabel({ model })?.value}</div>
            <div className="flex-1">
                <button onClick={() => setEligible(value => !value)}>Toggle eligibility</button>
                <button onClick={() => { if (pending) setModel(pending); setPending(null) }}>Confirm native settings</button>
                <output data-testid="reads">{reads}</output><output data-testid="sends">{sends}</output>
            </div>
            <HappyComposer sessionId="luna-fixture" agentFlavor="codex" active thinking={false} model={model}
                modelReasoningEffort="high" onModelReasoningEffortChange={() => {}}
                onModelChange={value => { if (typeof value === 'string') setPending(value) }}
                onModelMenuOpen={() => setReads(n => n + 1)}
                availableModelOptions={[
                    { value: 'gpt-6-astra', label: 'GPT-6 Astra' },
                    { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
                    ...(eligible || model === 'gpt-reserve' ? [{ value: 'gpt-reserve', label: '☾ Luna Reserve' }] : [])
                ]}
                codexUsage={{ ordinary: { primary: { remainingPercent: 0, windowDurationMins: 300, resetsAt: null }, secondary: null },
                    reserveAvailable: eligible,
                    reserve: model === 'gpt-reserve' ? { primary: null, secondary: { remainingPercent: 27, windowDurationMins: 10080, resetsAt: null } } : null }}
            />
        </main>
    </AssistantRuntimeProvider>
}
ReactDOM.createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><I18nProvider><Fixture /></I18nProvider></QueryClientProvider>)
