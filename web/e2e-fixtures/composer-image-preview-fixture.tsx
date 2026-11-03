import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { AssistantRuntimeProvider, ComposerPrimitive, useAuiState, useLocalRuntime, type AttachmentAdapter, type ChatModelAdapter } from '@assistant-ui/react'
import '../src/index.css'
import { SortableComposerAttachments } from '../src/components/AssistantChat/SortableComposerAttachments'
import { MessageAttachments } from '../src/components/AssistantChat/messages/MessageAttachments'
import { moveAttachmentId, reconcileAttachmentOrder } from '../src/lib/attachmentOrder'

const previewUrl = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220"><rect width="360" height="220" fill="#1769aa"/><circle cx="180" cy="110" r="70" fill="#ffc107"/></svg>')}`
const model: ChatModelAdapter = { async *run() {} }
const attachmentAdapter: AttachmentAdapter = {
    accept: 'image/*',
    async add({ file }) {
        return {
            id: file.name, name: file.name, type: 'image', contentType: file.type, file,
            status: { type: 'requires-action', reason: 'composer-send' }, previewUrl,
        }
    },
    async remove() {},
    async send(attachment) {
        return { ...attachment, status: { type: 'complete' }, content: [{ type: 'image', image: previewUrl }] }
    },
}

declare global {
    interface Window {
        __composerImagePreview?: {
            setDisabled: (disabled: boolean) => void
            clearAttachments: () => Promise<void>
        }
    }
}

function Composer({ disabled }: { disabled: boolean }) {
    const attachments = useAuiState((s) => s.composer.attachments)
    const [order, setOrder] = useState<string[]>([])
    const [ticks, setTicks] = useState(0)
    useEffect(() => {
        // Simulate status updates without a hub or a running agent.
        const interval = window.setInterval(() => setTicks((value) => value + 1), 100)
        return () => window.clearInterval(interval)
    }, [])
    const orderedIds = reconcileAttachmentOrder(order, attachments.map((a) => a.id))
    return (
        <main className="mx-auto max-w-2xl p-4">
            <p data-testid="refresh-count">{ticks}</p>
            <section aria-label="Sent images" className="mb-4">
                <MessageAttachments attachments={[{ id: 'sent', filename: 'sent.png', mimeType: 'image/png', size: 1, path: '/sent.png', previewUrl }]} />
            </section>
            <section aria-label="Composer" className="rounded-xl border p-4">
                <div className="flex flex-wrap gap-2">
                    <SortableComposerAttachments
                        attachments={attachments}
                        orderedAttachmentIds={orderedIds}
                        disabled={disabled}
                        onReorder={(activeId, targetId, position) => setOrder(moveAttachmentId(orderedIds, activeId, targetId, position))}
                    />
                </div>
                <ComposerPrimitive.Input aria-label="Draft" className="mt-4 w-full border" />
            </section>
        </main>
    )
}

function App() {
    const runtime = useLocalRuntime(model, { adapters: { attachments: attachmentAdapter } })
    const [disabled, setDisabled] = useState(false)
    useEffect(() => {
        window.__composerImagePreview = { setDisabled, clearAttachments: () => runtime.thread.composer.clearAttachments() }
        void (async () => {
            for (const name of ['first.png', 'second.png']) {
                await runtime.thread.composer.addAttachment(new File(['image'], name, { type: 'image/png' }))
            }
        })()
        return () => { delete window.__composerImagePreview }
    }, [runtime])
    return <AssistantRuntimeProvider runtime={runtime}><Composer disabled={disabled} /></AssistantRuntimeProvider>
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
