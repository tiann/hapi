import { useCallback, useState } from 'react'
import ReactDOM from 'react-dom/client'
import {
    AssistantRuntimeProvider, ComposerPrimitive, useAuiState, useLocalRuntime,
    type AttachmentAdapter, type ChatModelAdapter,
} from '@assistant-ui/react'
import '../src/index.css'
import { SortableComposerAttachments } from '../src/components/AssistantChat/SortableComposerAttachments'
import { MessageAttachments } from '../src/components/AssistantChat/messages/MessageAttachments'
import { moveAttachmentId, reconcileAttachmentOrder, type AttachmentDropPosition } from '../src/lib/attachmentOrder'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="#326ba8"/><circle cx="180" cy="120" r="80" fill="#ffc107"/></svg>'
const previewUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
const model: ChatModelAdapter = { async *run() {} }
const adapter: AttachmentAdapter = {
    accept: 'image/*,text/plain',
    async add({ file }) {
        return {
            id: file.name, name: file.name, type: 'file', contentType: file.type, file,
            status: { type: 'requires-action', reason: 'composer-send' },
            previewUrl: file.type.startsWith('image/') ? previewUrl : undefined,
        }
    },
    async remove() {},
    async send(attachment) {
        return { ...attachment, status: { type: 'complete' }, content: [{ type: 'text', text: attachment.name }] }
    },
}

function Composer() {
    const attachments = useAuiState((s) => s.composer.attachments)
    const [order, setOrder] = useState<string[]>([])
    const ids = reconcileAttachmentOrder(order, attachments.map((attachment) => attachment.id))
    const onReorder = useCallback((active: string, target: string, position: AttachmentDropPosition) => {
        setOrder((previous) => moveAttachmentId(
            reconcileAttachmentOrder(previous, attachments.map((attachment) => attachment.id)),
            active, target, position,
        ))
    }, [attachments])
    return (
        <section aria-label="Composer" className="rounded-xl border p-4">
            <div className="flex flex-wrap gap-2">
                <SortableComposerAttachments attachments={attachments} orderedAttachmentIds={ids} onReorder={onReorder} />
            </div>
            <ComposerPrimitive.Input aria-label="Draft" className="mt-4 w-full border" />
        </section>
    )
}

function App() {
    const runtime = useLocalRuntime(model, { adapters: { attachments: adapter } })
    const [loaded, setLoaded] = useState(false)
    const [loading, setLoading] = useState(false)
    const loadAttachments = async () => {
        setLoading(true)
        try {
            for (const name of ['first.png', 'second.png', 'notes.txt']) {
                await runtime.thread.composer.addAttachment(new File(['fixture'], name, {
                    type: name.endsWith('.png') ? 'image/png' : 'text/plain',
                }))
            }
            setLoaded(true)
        } finally {
            setLoading(false)
        }
    }
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <main className="mx-auto max-w-2xl p-4">
                <button type="button" disabled={loaded || loading} onClick={() => void loadAttachments()}>
                    Load attachments
                </button>
                <section aria-label="Sent" className="mb-4">
                    <MessageAttachments attachments={[{
                        id: 'sent', filename: 'sent.png', mimeType: 'image/png', size: 1, path: '/sent.png', previewUrl,
                    }]} />
                </section>
                <Composer />
            </main>
        </AssistantRuntimeProvider>
    )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
