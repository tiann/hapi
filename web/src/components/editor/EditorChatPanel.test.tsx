import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { EditorChatPanel } from './EditorChatPanel'

const useSessionMock = vi.fn()
const useMessagesMock = vi.fn()
const useSlashCommandsMock = vi.fn()
const useSkillsMock = vi.fn()
const useSendMessageMock = vi.fn()
const sessionChatMock = vi.fn()

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: (...args: unknown[]) => useSessionMock(...args)
}))

vi.mock('@/hooks/queries/useMessages', () => ({
    useMessages: (...args: unknown[]) => useMessagesMock(...args)
}))

vi.mock('@/hooks/queries/useSlashCommands', () => ({
    useSlashCommands: (...args: unknown[]) => useSlashCommandsMock(...args)
}))

vi.mock('@/hooks/queries/useSkills', () => ({
    useSkills: (...args: unknown[]) => useSkillsMock(...args)
}))

vi.mock('@/hooks/mutations/useSendMessage', () => ({
    useSendMessage: (...args: unknown[]) => useSendMessageMock(...args)
}))

vi.mock('@/components/SessionChat', () => ({
    SessionChat: (props: unknown) => {
        sessionChatMock(props)
        return <div data-testid="session-chat">Session Chat</div>
    }
}))

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: { path: '/repo', host: 'host', flavor: 'codex' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        backgroundTaskCount: 0,
        todos: undefined,
        teamState: undefined,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        permissionMode: 'default',
        collaborationMode: undefined,
        ...overrides
    }
}

describe('EditorChatPanel', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        useSessionMock.mockReturnValue({ session: makeSession(), isLoading: false, error: null, refetch: vi.fn() })
        useMessagesMock.mockReturnValue({
            messages: [],
            warning: null,
            isLoading: false,
            isLoadingMore: false,
            hasMore: false,
            pendingCount: 0,
            messagesVersion: 0,
            loadMore: vi.fn(),
            refetch: vi.fn(),
            flushPending: vi.fn(),
            setAtBottom: vi.fn()
        })
        useSlashCommandsMock.mockReturnValue({ commands: [], isLoading: false, error: null, getSuggestions: vi.fn(async () => ['slash']) })
        useSkillsMock.mockReturnValue({ skills: [], isLoading: false, error: null, getSuggestions: vi.fn(async () => ['skill']) })
        useSendMessageMock.mockReturnValue({ sendMessage: vi.fn(), retryMessage: vi.fn(), isSending: false })
    })

    afterEach(() => {
        cleanup()
    })

    it('prompts when no session is selected', () => {
        render(<EditorChatPanel api={{} as ApiClient} sessionId={null} />)

        expect(screen.getByText('Select or create a session to chat')).toBeInTheDocument()
        expect(sessionChatMock).not.toHaveBeenCalled()
    })

    it('shows a loading state while the session loads', () => {
        useSessionMock.mockReturnValueOnce({ session: null, isLoading: true, error: null, refetch: vi.fn() })

        render(<EditorChatPanel api={{} as ApiClient} sessionId="session-1" />)

        expect(screen.getByText('Loading chat...')).toBeInTheDocument()
        expect(sessionChatMock).not.toHaveBeenCalled()
    })

    it('passes compact chat props to SessionChat when loaded', () => {
        const api = {} as ApiClient

        render(<EditorChatPanel api={api} sessionId="session-1" />)

        expect(screen.getByTestId('session-chat')).toBeInTheDocument()
        expect(useSessionMock).toHaveBeenCalledWith(api, 'session-1')
        expect(useMessagesMock).toHaveBeenCalledWith(api, 'session-1')
        expect(useSlashCommandsMock).toHaveBeenCalledWith(api, 'session-1', 'codex')
        expect(sessionChatMock).toHaveBeenCalledWith(expect.objectContaining({
            api,
            compactMode: true,
            hideHeader: true,
            disableVoice: true,
            availableSlashCommands: []
        }))
    })

    it('sends and consumes pending draft text', () => {
        const sendMessage = vi.fn()
        const onDraftConsumed = vi.fn()
        useSendMessageMock.mockReturnValueOnce({ sendMessage, retryMessage: vi.fn(), isSending: false })

        render(
            <EditorChatPanel
                api={{} as ApiClient}
                sessionId="session-1"
                pendingDraftText="@/repo/src/App.tsx"
                onDraftConsumed={onDraftConsumed}
            />
        )

        expect(screen.getByText('Added to chat: @/repo/src/App.tsx')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: 'Send added context' }))

        expect(sendMessage).toHaveBeenCalledWith('@/repo/src/App.tsx')
        expect(onDraftConsumed).toHaveBeenCalled()
    })
})
