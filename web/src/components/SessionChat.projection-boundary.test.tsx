import { useEffect, useMemo, useRef, useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveLatestCompletedBoundaryIdForView } from './SessionChat'
import { HappyChatProvider } from './AssistantChat/context'
import { HappyAssistantMessage } from './AssistantChat/messages/AssistantMessage'
import { I18nProvider } from '@/lib/i18n-context'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { filterConciseChatBlocks } from '@/chat/conciseView'
import { buildVisibleChatBlocks, type VisibleChatBlock } from '@/chat/toolGroups'
import { findLatestCompletedBoundaryId, useHappyRuntime } from '@/lib/assistant-runtime'
import { clearMessageWindow, getMessageWindowState, loadMessageContext, setMessageViewMode, syncTailMessages, type MessageWindowState } from '@/lib/message-window-store'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, MessageContextResponse, MessagesResponse, Session, SessionMetadataSummary } from '@/types/api'

function conversation(prefix: string, seq: number, work: 'tool' | 'reasoning'): DecryptedMessage[] {
    const wire = (id: string, data: unknown): DecryptedMessage => ({ id, seq: ++seq, localId: `${id}-local`, createdAt: seq * 1000,
        content: { role: 'agent', content: { type: 'codex', data } } })
    return [
        { id: `${prefix}-user`, seq, localId: `${prefix}-user-local`, createdAt: seq * 1000, invokedAt: seq * 1000,
            content: { role: 'user', content: { type: 'text', text: `${prefix} prompt` } } },
        ...(work === 'tool' ? [wire(`${prefix}-work`, { type: 'tool-call', callId: `${prefix}-tool`, name: 'Read', input: {} }),
            wire(`${prefix}-result`, { type: 'tool-call-result', callId: `${prefix}-tool`, output: 'ok' })]
            : [wire(`${prefix}-work`, { type: 'reasoning', message: `${prefix} nonempty reasoning` })]),
        wire(`${prefix}-final`, { type: 'message', message: `${prefix} final answer` })
    ]
}
function latest(messages: DecryptedMessage[]): MessagesResponse {
    const last = messages.at(-1)!
    return { messages, page: { direction: 'latest', limit: 200, epoch: 0, reset: false, nextBeforeAt: messages[0].createdAt,
        nextBeforeSeq: messages[0].seq, nextAfterAt: null, nextAfterSeq: null,
        snapshotHeadAt: last.createdAt, snapshotHeadSeq: last.seq, hasMore: true } }
}
function context(messages: DecryptedMessage[], head: DecryptedMessage, targetMessageId: string): MessageContextResponse {
    return { messages, targetMessageId, page: { epoch: 0, hasMore: true, nextBeforeAt: messages[0].createdAt,
        nextBeforeSeq: messages[0].seq, snapshotHeadAt: head.createdAt, snapshotHeadSeq: head.seq } }
}

type Memory = { id: string | null; tailRevision: number; sessionId: string; canonicalBlocks: readonly ChatBlock[]; visibleBlocks: readonly VisibleChatBlock[] }
type Props = { state: MessageWindowState; api: ApiClient; concise: boolean; search?: boolean; running?: boolean; sessionId?: string; revision?: number }
function Pipeline({ state, api, concise, search, running = false, sessionId = state.sessionId, revision = state.tailRevision }: Props) {
    const prior = useRef(new Map<string, ChatBlock>())
    const canonical = useMemo(() => {
        const normalized = state.messages.map(normalizeDecryptedMessage).filter((message): message is NormalizedMessage => message !== null)
        const reconciled = reconcileChatBlocks(reduceChatBlocks(normalized, null).blocks, prior.current)
        prior.current = reconciled.byId
        return reconciled.blocks
    }, [state.messages])
    const canonicalSnapshot = JSON.stringify(canonical)
    const visible = useMemo(() => buildVisibleChatBlocks(concise && !search ? filterConciseChatBlocks(canonical) : canonical,
        { hasMoreMessages: state.hasMore }), [canonical, concise, search, state.hasMore])
    const current = state.viewMode === 'tail' ? findLatestCompletedBoundaryId(visible, running, running ? 1 : null) : null
    const [memory, setMemory] = useState<Memory | null>(null)
    // Exercise the existing tail-only observation protocol, with real source and
    // runtime views attached. The resolver is the production SessionChat function.
    useEffect(() => {
        if (state.viewMode === 'tail') setMemory({ id: current, tailRevision: revision, sessionId, canonicalBlocks: canonical, visibleBlocks: visible })
    }, [state.viewMode, current, revision, sessionId, canonical, visible])
    const scope = { sessionId, canonicalBlocks: canonical, visibleBlocks: visible, isRunning: running, activeTurnStartedAt: running ? 1 : null }
    const boundary = resolveLatestCompletedBoundaryIdForView(state.viewMode, current, memory, revision, scope)
    const session = { id: sessionId, active: true, thinking: running, activeTurnStartedAt: running ? 1 : null } as Session
    const runtime = useHappyRuntime({ session, blocks: visible, messagesVersion: state.messagesVersion, historyVersion: state.historyVersion,
        viewMode: state.viewMode, isSending: false, isRunning: running, onSendMessage: () => {}, onAbort: async () => {} })
    return <I18nProvider><AssistantRuntimeProvider runtime={runtime}><HappyChatProvider value={{ api, sessionId,
        metadata: { capabilities: { conversationHistory: { forkCurrent: true } } } as SessionMetadataSummary,
        terminalToolDisplayMode: 'compact', showSessionSummaryInChat: false, disabled: false,
        onRefresh: () => {}, onForkConversation: async () => {}, isLatestCompletedBoundary: id => id === boundary,
        hasMoreMessages: state.hasMore, isSyncingTail: false, isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'terminal-stop' }}>
        <output data-testid="boundary">{boundary ?? 'none'}</output>
        <output data-testid="immutable">{canonicalSnapshot === JSON.stringify(canonical) ? 'true' : 'false'}</output>
        <ThreadPrimitive.Root><ThreadPrimitive.Messages components={{ UserMessage: () => null, AssistantMessage: HappyAssistantMessage }} /></ThreadPrimitive.Root>
    </HappyChatProvider></AssistantRuntimeProvider></I18nProvider>
}
const sessions: string[] = []
afterEach(() => { for (const id of sessions) clearMessageWindow(id); sessions.length = 0 })
async function setup(work: 'tool' | 'reasoning', concise: boolean) {
    const id = `projection-${work}-${sessions.length}`
    sessions.push(id)
    const current = conversation('latest', 1000, work)
    const older = conversation('older', 1, 'reasoning')
    let contextMessages = current
    const api = { getMessages: vi.fn(async () => latest(current)),
        getMessageContext: vi.fn(async (_session: string, target: string) => context(contextMessages, current.at(-1)!, target)) } as unknown as ApiClient
    await syncTailMessages(api, id)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let props: Props = { state: getMessageWindowState(id), api, concise }
    const node = () => <QueryClientProvider client={client}><Pipeline {...props} /></QueryClientProvider>
    const rendered = render(node())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Fork' })).toBeTruthy())
    const update = (patch: Partial<Props>) => { props = { ...props, ...patch }; rendered.rerender(node()) }
    const load = async (messages: DecryptedMessage[], target = messages.at(-1)!.id) => {
        contextMessages = messages
        await act(async () => { expect(await loadMessageContext(api, id, target)).toBe(true) })
        update({ state: getMessageWindowState(id) })
    }
    return { id, current, older, update, load }
}
function forkAnchor(): string | null {
    return screen.getByRole('button', { name: 'Fork' }).closest('[data-hapi-message-role="assistant"]')?.id ?? null
}

describe('completed response identity across projections and real context windows', () => {
    it('preserves current Fork through full tail → history → concise off/on on the same actual runtime card', async () => {
        const test = await setup('tool', false)
        const before = forkAnchor()
        act(() => setMessageViewMode(test.id, 'history'))
        test.update({ state: getMessageWindowState(test.id), concise: true })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Fork' })).toBeTruthy())
        expect(screen.getByTestId('immutable').textContent).toBe('true')
        expect(forkAnchor()).not.toBe(before)
        test.update({ concise: false })
        await waitFor(() => expect(forkAnchor()).toBe(before))
    })

    it('restores current Fork on reverse search reload and on search dismissal at unchanged tailRevision', async () => {
        const test = await setup('reasoning', true)
        const initial = getMessageWindowState(test.id)
        const before = forkAnchor()
        await test.load(test.older)
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
        expect(getMessageWindowState(test.id).messages.some(message => message.id === 'latest-final')).toBe(false)
        test.update({ search: true })
        await test.load(test.current, 'latest-final')
        const restored = getMessageWindowState(test.id)
        expect(restored.viewMode).toBe('history')
        expect(restored.tailRevision).toBe(initial.tailRevision)
        expect(restored.historyVersion).toBeGreaterThan(initial.historyVersion)
        await waitFor(() => expect(screen.getByRole('button', { name: 'Fork' })).toBeTruthy())
        expect(screen.getByTestId('immutable').textContent).toBe('true')
        expect(forkAnchor()).not.toBe(before)
        test.update({ search: false })
        await waitFor(() => expect(forkAnchor()).toBe(before))
        expect(test.current.map(message => [message.id, message.localId])).toEqual(restored.messages.map(message => [message.id, message.localId]))
    })

    it.each(['absent', 'revision', 'session', 'active', 'user', 'event', 'compaction', 'source', 'partial', 'owner'] as const)('hides current Fork for unproven %s identity', async negative => {
        const test = await setup('tool', false)
        act(() => setMessageViewMode(test.id, 'history'))
        test.update({ state: getMessageWindowState(test.id) })
        if (negative === 'absent') {
            await test.load(test.older)
            expect(getMessageWindowState(test.id).messages.some(message => message.id === 'latest-final')).toBe(false)
        }
        else if (negative === 'partial') await test.load([test.current.at(-1)!])
        else if (negative === 'revision') test.update({ revision: getMessageWindowState(test.id).tailRevision + 1 })
        else if (negative === 'session') test.update({ sessionId: 'different-session' })
        else if (negative === 'active') test.update({ running: true })
        else {
            const changed = [...test.current]
            if (negative === 'owner') changed[changed.length - 1] = { ...changed.at(-1)!, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'latest final answer', turn_id: 'different-response' } } } }
            else if (negative === 'source') changed[changed.length - 1] = { ...changed.at(-1)!, id: 'different-final-source' }
            else if (negative === 'user') changed.splice(-1, 0, { ...changed[0], id: 'other-user', localId: 'other-local', createdAt: 1003500, invokedAt: 1003500 })
            else changed.splice(-1, 0, { id: 'separator', localId: null, seq: 1002.5, createdAt: 1002500,
                content: { role: 'agent', content: { type: 'codex', data: negative === 'compaction'
                    ? { type: 'compact-summary', summary: 'compacted', compactionId: 'compact' }
                    : { type: 'error', message: 'response separator' } } } })
            await test.load(changed)
        }
        expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull()
    })
})
