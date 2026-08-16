/*
 * Standalone Vite-served fixture for the composer copy Playwright spec.
 * Mounts the real RichComposerInput inside a realistic chat page layout
 * (message thread above the composer) and wires the real
 * `applyGlobalSelectAll` takeover from SessionChat, so a real Chromium
 * can drive Ctrl+A / Ctrl+C against the actual code paths.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { useState } from 'react'
import { RichComposerInput } from '../src/components/AssistantChat/RichComposerInput'
import { applyGlobalSelectAll } from '../src/components/SessionChat'

declare global {
    interface Window {
        __composerCopyE2E?: {
            setValue: (value: string) => void
            getValue: () => string
        }
    }
}

// Mirrors the SessionChat effect: the takeover must live at window scope
// because the broken case is focus on the page body / message thread.
window.addEventListener('keydown', applyGlobalSelectAll)

function Harness() {
    const [value, setValue] = useState('')
    window.__composerCopyE2E = {
        setValue,
        getValue: () => value,
    }
    return (
        <div style={{ padding: 40, width: 640 }}>
            <div data-testid="message-thread" style={{ marginBottom: 24 }}>
                <div className="happy-thread-messages flex flex-col gap-3">
                    <div data-testid="assistant-message-1" className="happy-chat-text" style={{ whiteSpace: 'pre-wrap' }}>
                        {'The quick brown fox jumps over the lazy dog.\nSecond line of the first reply.'}
                    </div>
                    <div data-testid="assistant-message-2" className="happy-chat-text" style={{ whiteSpace: 'pre-wrap' }}>
                        {'Another assistant message with a code block:\nconst x = 1;'}
                    </div>
                    <div data-testid="user-message-1" className="happy-user-bubble happy-chat-text" style={{ whiteSpace: 'pre-wrap' }}>
                        {'my earlier user message'}
                    </div>
                </div>
            </div>
            <RichComposerInput
                value={value}
                placeholder="Type a message"
                onValueChange={setValue}
                onMirrorChange={() => {}}
            />
        </div>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <Harness />
    </React.StrictMode>
)
