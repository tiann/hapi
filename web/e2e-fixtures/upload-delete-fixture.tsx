import React, { useCallback, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantRuntimeProvider, ComposerPrimitive, useExternalStoreRuntime, useAuiState } from '@assistant-ui/react'
import { ApiClient } from '../src/api/client'
import { createAttachmentAdapter } from '../src/lib/attachmentAdapter'
import { createScratchlistAttachmentAdapter } from '../src/lib/scratchlistAttachmentAdapter'
import type { AppendMessage, ThreadMessage } from '@assistant-ui/react'
import { AttachmentItem } from '../src/components/AssistantChat/AttachmentItem'
import { I18nProvider } from '../src/lib/i18n-context'
import '../src/index.css'

function Contents() {
    const attachments = useAuiState((s) => s.composer.attachments)
    return <ComposerPrimitive.Root>
        <div style={{ display: 'flex', gap: 16, marginBlock: 20 }}>
            {attachments.map((attachment, index) => <div key={attachment.id} data-hapi-composer-attachment-id={attachment.id} data-name={attachment.name}>
                <ComposerPrimitive.AttachmentByIndex index={index} components={{ Attachment: AttachmentItem }} />
            </div>)}
        </div>
        <pre data-testid="state" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(attachments.map((a) => ({ name: a.name, status: a.status.type })))}
        </pre>
        <ComposerPrimitive.Input placeholder="Message" />
        <ComposerPrimitive.Send aria-label="Send">Send</ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
}

function Fixture() {
    const [sent, setSent] = useState<AppendMessage | null>(null)
    const adapter = useMemo(() => {
        const api = new ApiClient('')
        return new URLSearchParams(location.search).get('mode') === 'scratchlist'
            ? createScratchlistAttachmentAdapter(api, 'fixture')
            : createAttachmentAdapter(api, 'fixture')
    }, [])
    const onNew = useCallback(async (message: AppendMessage) => { setSent(message) }, [])
    const runtime = useExternalStoreRuntime<ThreadMessage>({ messages: [], onNew, adapters: { attachments: adapter } })
    return <AssistantRuntimeProvider runtime={runtime}>
        <main style={{ padding: 32, fontFamily: 'system-ui' }}>
            <h1>Issue #2118: attachment removal</h1>
            <p>Real HAPI attachment UI, adapter and composer runtime. Synthetic images; controlled HTTP responses.</p>
            <label>Add image <input type="file" accept="image/*" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void runtime.thread.composer.addAttachment(file)
                event.target.value = ''
            }} /></label>
            <Contents />
            <pre data-testid="sent" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(sent)}</pre>
        </main>
    </AssistantRuntimeProvider>
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>)
