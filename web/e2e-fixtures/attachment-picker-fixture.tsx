import React from 'react'
import { AssistantRuntimeProvider, useLocalRuntime, type ChatModelAdapter } from '@assistant-ui/react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { AttachmentPicker } from '../src/components/AssistantChat/AttachmentPicker'
import { ComposerButtons } from '../src/components/AssistantChat/ComposerButtons'
import { I18nProvider } from '../src/lib/i18n-context'

declare global {
    interface Window {
        __attachmentPickerE2E?: {
            selectedNames: string[]
        }
    }
}

const adapter: ChatModelAdapter = {
    async *run() {},
}

function ComposerToolbarFixture() {
    const noop = () => {}
    return (
        <ComposerButtons
            canSend={false}
            controlsDisabled={false}
            showSettingsButton={false}
            onSettingsToggle={noop}
            expanded={false}
            onExpandedToggle={noop}
            showTerminalButton={false}
            terminalDisabled={false}
            terminalLabel="Terminal"
            onTerminal={noop}
            showAbortButton={false}
            abortDisabled={false}
            isAborting={false}
            onAbort={noop}
            showSwitchButton={false}
            switchDisabled={false}
            isSwitching={false}
            onSwitch={noop}
            voiceEnabled={false}
            voiceStatus="disconnected"
            onVoiceToggle={noop}
            onSend={noop}
        />
    )
}

function App() {
    const runtime = useLocalRuntime(adapter)
    const isToolbarFixture = new URL(window.location.href).searchParams.get('toolbar') === '1'
    if (!window.__attachmentPickerE2E) {
        window.__attachmentPickerE2E = { selectedNames: [] }
    }

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <I18nProvider>
                <main style={{ minHeight: '100vh', padding: '1rem', background: 'var(--app-bg)' }}>
                    <div style={{ maxWidth: 420, margin: 'auto', paddingTop: '55vh' }}>
                        {isToolbarFixture ? (
                            <ComposerToolbarFixture />
                        ) : (
                            <AttachmentPicker
                                onFilesSelected={(files) => {
                                    window.__attachmentPickerE2E!.selectedNames = files.map((file) => file.name)
                                }}
                            />
                        )}
                    </div>
                </main>
            </I18nProvider>
        </AssistantRuntimeProvider>
    )
}

const rootEl = document.getElementById('root')
if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    )
}
