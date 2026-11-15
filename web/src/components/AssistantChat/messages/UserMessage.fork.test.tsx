import type { PropsWithChildren } from 'react'
import { useMemo, useRef } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
    AssistantRuntimeProvider,
    ThreadPrimitive,
    unstable_useThreadMessageIds,
} from '@assistant-ui/react'
import { I18nProvider } from '@/lib/i18n-context'
import { reduceChatBlocks } from '@/chat/reducer'
import { reconcileChatBlocks } from '@/chat/reconcile'
import { buildVisibleChatBlocks } from '@/chat/toolGroups'
import { findLatestCompletedBoundaryId, useHappyRuntime } from '@/lib/assistant-runtime'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import type { ChatBlock, NormalizedMessage } from '@/chat/types'
import type { Session } from '@/types/api'

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}))

vi.mock('@radix-ui/react-popover', () => ({
    Root: ({ children }: PropsWithChildren) => <>{children}</>,
    Trigger: ({ children }: PropsWithChildren) => <>{children}</>,
    Portal: ({ children }: PropsWithChildren) => <div>{children}</div>,
    Content: ({ children }: PropsWithChildren) => <div>{children}</div>,
}))

const BASE_AT = 1_700_000_000_000

function buildMessages(): NormalizedMessage[] {
    return [1, 2, 3].flatMap((turn) => {
        const at = BASE_AT + turn * 10_000
        return [
            {
                id: `u-msg-${turn}`,
                localId: `u-local-${turn}`,
                createdAt: at,
                invokedAt: at,
                role: 'user',
                content: { type: 'text', text: `Fixture user message ${turn}` },
                isSidechain: false,
            },
            {
                id: `a-msg-${turn}`,
                localId: null,
                createdAt: at + 1_000,
                invokedAt: at + 1_000,
                role: 'agent',
                content: [{ type: 'text', text: `Fixture assistant reply ${turn}`, uuid: `a-uuid-${turn}`, parentUUID: null }],
                isSidechain: false,
            },
        ] as NormalizedMessage[]
    })
}

const fakeMetadata = {
    path: '/tmp/fork-fixture',
    host: 'fixture',
    flavor: 'opencode',
    capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true } },
    conversationHistoryPoints: {
        'u-local-1': true,
        'u-local-2': true,
        'u-local-3': true,
    },
}

const fakeSession = {
    id: 'fork-regression-session',
    active: true,
    thinking: false,
    activeTurnStartedAt: null,
    agentState: null,
    metadata: fakeMetadata,
} as unknown as Session

function ThreadMessages() {
    const ids = unstable_useThreadMessageIds()
    return (
        <>
            {ids.map((id) => (
                <ThreadPrimitive.Unstable_MessageById
                    key={id}
                    messageId={id}
                    components={{
                        UserMessage: HappyUserMessage,
                        AssistantMessage: HappyAssistantMessage,
                        SystemMessage: HappySystemMessage,
                    }}
                />
            ))}
        </>
    )
}

function Harness({ boundaryProbe }: { boundaryProbe: { id: string | null } }) {
    const blocksByIdRef = useRef<Map<string, ChatBlock>>(new Map())
    const messages = useMemo(() => buildMessages(), [])
    const reduced = useMemo(() => reduceChatBlocks(messages, null, {}), [messages])
    const reconciled = useMemo(
        () => reconcileChatBlocks(reduced.blocks, blocksByIdRef.current),
        [reduced.blocks],
    )
    blocksByIdRef.current = reconciled.byId
    const visibleBlocks = useMemo(
        () => buildVisibleChatBlocks(reconciled.blocks, { hasMoreMessages: false }),
        [reconciled.blocks],
    )
    const boundaryId = useMemo(
        () => findLatestCompletedBoundaryId(visibleBlocks, false, null),
        [visibleBlocks],
    )
    boundaryProbe.id = boundaryId
    const runtime = useHappyRuntime({
        session: fakeSession,
        blocks: visibleBlocks,
        messagesVersion: 1,
        historyVersion: 1,
        viewMode: 'tail',
        isSending: false,
        onSendMessage: () => {},
        onAbort: async () => {},
    })
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyChatProvider
                value={{
                    api: {} as never,
                    sessionId: fakeSession.id,
                    metadata: fakeMetadata as never,
                    terminalToolDisplayMode: 'detailed',
                    showSessionSummaryInChat: false,
                    disabled: false,
                    onRefresh: () => {},
                    onForkConversation: async () => {},
                    onRewindConversation: undefined,
                    isLatestCompletedBoundary: (id: string) => id === boundaryId,
                    onShareTurn: () => {},
                    hasMoreMessages: false,
                    isSyncingTail: false,
                    isLoadingMoreMessages: false,
                    onNestedScrollFollowChange: () => {},
                    loadOlderMessagesPreservingScroll: async () => ({ kind: 'stopped', reason: 'exhausted' }) as never,
                }}
            >
                <ThreadPrimitive.Root>
                    <ThreadMessages />
                </ThreadPrimitive.Root>
            </HappyChatProvider>
        </AssistantRuntimeProvider>
    )
}

// Regression guard for the OpenCode historical-fork affordance: with
// conversationHistory points on every completed user turn, the Fork button
// must render on every user message that has a point — not only on the
// last one. Mirrors e2e/opencode-fork-buttons.spec.ts, which covers the
// same contract in a real browser.
describe('UserMessage historical fork affordance', () => {
    it('renders a Fork button on every user message that has a history point', async () => {
        const boundaryProbe: { id: string | null } = { id: null }
        render(
            <I18nProvider>
                <Harness boundaryProbe={boundaryProbe} />
            </I18nProvider>,
        )
        const userCards = await screen.findAllByText(/Fixture user message \d/)
        expect(userCards).toHaveLength(3)
        for (const text of userCards) {
            const card = text.closest('[data-hapi-message-role="user"]')
            expect(card).not.toBeNull()
            expect(card!.querySelectorAll('[data-testid="message-fork"]')).toHaveLength(1)
        }
    })

    it('keeps current-only behavior on the latest completed boundary', async () => {
        const boundaryProbe: { id: string | null } = { id: null }
        render(
            <I18nProvider>
                <Harness boundaryProbe={boundaryProbe} />
            </I18nProvider>,
        )
        await screen.findAllByText(/Fixture user message \d/)
        expect(boundaryProbe.id).toMatch(/^agent-text:/)
        const anchor = document.getElementById(`hapi-message-${boundaryProbe.id}`)
        expect(anchor).not.toBeNull()
        expect(anchor!.querySelectorAll('[data-testid="message-fork"]')).toHaveLength(1)
    })
})
