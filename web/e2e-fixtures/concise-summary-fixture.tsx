import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { normalizeDecryptedMessage } from '../src/chat/normalize'
import { reduceChatBlocks } from '../src/chat/reducer'
import { reconcileChatBlocks } from '../src/chat/reconcile'
import { filterConciseChatBlocks } from '../src/chat/conciseView'
import { buildVisibleChatBlocks } from '../src/chat/toolGroups'
import { aggregateResponseGroups } from '../src/lib/assistant-runtime'
import { MessageMetadata } from '../src/components/AssistantChat/messages/MessageMetadata'
import type { NormalizedMessage } from '../src/chat/types'
import '../src/index.css'

const messages: NormalizedMessage[] = [
    { id: 'user', localId: null, createdAt: 1, role: 'user', isSidechain: false, content: { type: 'text', text: 'Inspect the fixture and report the result.' } },
    { id: 'work', localId: null, createdAt: 2, role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'read', name: 'Read', input: { path: 'fixture.txt' }, description: null, uuid: 'read', parentUUID: null }] },
    { id: 'final', localId: null, createdAt: 3, role: 'agent', isSidechain: false, content: [{ type: 'text', text: 'The fixture is ready.', uuid: 'final', parentUUID: null }] }
]
const summary = normalizeDecryptedMessage({ id: 'summary', seq: 4, localId: null, createdAt: 4,
    content: { role: 'agent', content: { type: 'codex', data: { type: 'round-summary', summary: {
        usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { 'fixture/model': { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        total_cost_usd: 0.02, num_turns: 2, duration_ms: 9000, generation_ms: 1500, generation_output_tokens: 30
    } } } } })!

function Fixture() {
    const [concise, setConcise] = useState(true)
    const [late, setLate] = useState(false)
    const canonical = reconcileChatBlocks(reduceChatBlocks(late ? messages : [...messages, summary], null).blocks, new Map()).blocks
    const snapshot = JSON.stringify(canonical)
    const projected = concise ? filterConciseChatBlocks(canonical) : canonical
    const visible = buildVisibleChatBlocks(projected, { hasMoreMessages: false })
    const aggregates = aggregateResponseGroups(visible)
    return <main className="mx-auto max-w-xl space-y-6 p-8">
        <h1 className="text-xl font-semibold">Concise response summary</h1>
        <p>Isolated synthetic rendering fixture using the production chat pipeline.</p>
        <label className="block"><input type="checkbox" checked={concise} onChange={event => setConcise(event.target.checked)} /> Concise view</label>
        <label className="block"><input type="checkbox" checked={late} onChange={event => setLate(event.target.checked)} /> Summary pending</label>
        <section className="space-y-4 rounded-xl border p-6" data-testid="thread" data-immutable={snapshot === JSON.stringify(canonical)}>
            {visible.map(block => <div key={block.id} data-block-id={block.id} data-kind={block.kind}>
                <p>{block.kind === 'user-text' || block.kind === 'agent-text' ? block.text : 'Read fixture.txt'}</p>
                {aggregates.has(block.id) && <div data-testid="metadata"><MessageMetadata {...aggregates.get(block.id)!} /></div>}
            </div>)}
        </section>
    </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
