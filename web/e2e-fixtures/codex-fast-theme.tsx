import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider } from '@assistant-ui/react'
import { HappyComposer } from '../src/components/AssistantChat/HappyComposer'
import { useHappyRuntime } from '../src/lib/assistant-runtime'
import { I18nProvider } from '../src/lib/i18n-context'
import type { Session } from '../src/types/api'
import '../src/index.css'

const session = { id: 'fast-theme-fixture', active: true, thinking: false } as Session

function Fixture() {
    const [serviceTier, setServiceTier] = useState<string | null>('fast')
    const runtime = useHappyRuntime({ session, blocks: [], messagesVersion: 0, historyVersion: 0,
        isSending: false, isRunning: false, onSendMessage: () => {}, onAbort: async () => {} })
    return <AssistantRuntimeProvider runtime={runtime}>
        <main className="mx-auto max-w-3xl pt-40">
            <HappyComposer agentFlavor="codex" active model="gpt-5.6" serviceTier={serviceTier}
                onServiceTierChange={setServiceTier} onModelChange={() => {}}
                availableModelOptions={[{ value: 'gpt-5.6', label: 'GPT-5.6' }]} />
        </main>
    </AssistantRuntimeProvider>
}

createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>)
