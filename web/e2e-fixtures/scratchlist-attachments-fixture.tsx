import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ScratchlistDrawer } from '../src/components/AssistantChat/ScratchlistPanel'
import type { ScratchlistEntry } from '../src/lib/scratchlist'
import type { ApiClient } from '../src/api/client'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240"><rect width="360" height="240" fill="#326ba8"/><circle cx="180" cy="120" r="80" fill="#ffc107"/></svg>'
const previewUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
const image = { id: 'photo', filename: 'photo.png', mimeType: 'image/png', size: 120, path: '/photo.png', previewUrl }
const file = { id: 'file', filename: 'notes.txt', mimeType: 'text/plain', size: 16, path: '/notes.txt' }
const storageKey = 'scratchlist-attachment-fixture'
let uploadSequence = 0
const api = {
    async uploadScratchlistAttachment(_sessionId: string, filename: string, content: string, mimeType: string) {
        uploadSequence += 1
        const id = `uploaded-${uploadSequence}`
        return {
            success: true,
            attachment: {
                id,
                filename,
                mimeType,
                size: Math.ceil(content.length * 3 / 4),
                path: `hapi-hub:scratchlist/default/attachment-fixture/${id}-${filename}`,
            },
        }
    },
    async deleteScratchlistAttachment() {},
} as unknown as ApiClient

function App() {
    const [entries, setEntries] = useState<ScratchlistEntry[]>(() => JSON.parse(localStorage.getItem(storageKey) ?? 'null') ?? [{ id: 'draft', text: 'Draft note', createdAt: 1, attachments: [] }])
    const [updates, setUpdates] = useState(0)
    const [failSave, setFailSave] = useState(false)
    const [action, setAction] = useState('')
    const save = (next: ScratchlistEntry[]) => { localStorage.setItem(storageKey, JSON.stringify(next)); setEntries(next) }
    return <I18nProvider><main className="mx-auto max-w-2xl p-4">
        <div className="mb-4 flex flex-wrap gap-3">
            <button onClick={() => save([{ ...entries[0]!, attachments: [image] }])}>Single image</button>
            <button onClick={() => save([{ ...entries[0]!, attachments: [file] }])}>Single file</button>
            <button onClick={() => save([{ ...entries[0]!, attachments: [image, file] }])}>Mixed attachments</button>
            <button onClick={() => save([{ ...entries[0]!, attachments: [image, { ...image, id: 'second', filename: 'second.png' }] }])}>Two images</button>
            <button onClick={() => save([{ ...entries[0]!, attachments: [file, { ...file, id: 'second-file', filename: 'second.txt' }] }])}>Two files</button>
            <button onClick={() => setFailSave((value) => !value)}>Toggle save failure</button>
        </div>
        <ScratchlistDrawer entries={entries} sessionId="attachment-fixture" api={api}
            onSend={async () => { setAction('send'); return false }}
            onSchedule={async (_entry, pending) => { setAction(JSON.stringify(pending)); return false }}
            onUpdate={async (id, text, attachments) => {
                if (failSave) throw new Error('Save failed')
                setUpdates((value) => value + 1)
                save(entries.map((entry) => entry.id === id ? { ...entry, text, attachments: attachments ?? entry.attachments } : entry))
            }}
            onDelete={(id) => save(entries.filter((entry) => entry.id !== id))}
            onReorder={() => { throw new Error('Attachment gestures must not reorder draft rows') }} />
        <output data-testid="updates">{updates}</output>
        <output data-testid="order">{JSON.stringify(entries[0]?.attachments?.map((a) => a.id))}</output>
        <output data-testid="action">{action}</output>
    </main></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<App />)
