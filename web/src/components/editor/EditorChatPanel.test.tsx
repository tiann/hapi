import { cleanup, render, screen } from '@testing-library/react'
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
const sessionChatLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }))

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

vi.mock('@/components/SessionChat', async () => {
    const React = await vi.importActual<typeof import('react')>('react')
    return {
        SessionChat: (props: {
            session?: Session
            composerAppendText?: string
            onComposerAppendTextConsumed?: () => void
            onNewSessionRequested?: () => void
        }) => {
        sessionChatMock(props)
            React.useEffect(() => {
                sessionChatLifecycle.mounts += 1
                return () => {
                    sessionChatLifecycle.unmounts += 1
                }
            }, [])
            return <div data-testid="session-chat">Session Chat {props.session?.id}</div>
        }
    }
})

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
        sessionChatLifecycle.mounts = 0
        sessionChatLifecycle.unmounts = 0
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
        const onNewSessionRequested = vi.fn()

        render(<EditorChatPanel api={api} sessionId="session-1" onNewSessionRequested={onNewSessionRequested} />)

        expect(screen.getByTestId('session-chat')).toBeInTheDocument()
        expect(useSessionMock).toHaveBeenCalledWith(api, 'session-1')
        expect(useMessagesMock).toHaveBeenCalledWith(api, 'session-1')
        expect(useSlashCommandsMock).toHaveBeenCalledWith(api, 'session-1', 'codex')
        expect(sessionChatMock).toHaveBeenCalledWith(expect.objectContaining({
            api,
            compactMode: true,
            hideHeader: true,
            disableVoice: true,
            availableSlashCommands: [],
            onNewSessionRequested
        }))
    })

    it('sends and consumes pending draft text', () => {
        const onDraftConsumed = vi.fn()

        render(
            <EditorChatPanel
                api={{} as ApiClient}
                sessionId="session-1"
                pendingDraftText="@/repo/src/App.tsx"
                onDraftConsumed={onDraftConsumed}
            />
        )

        expect(screen.queryByText('Added to chat: @/repo/src/App.tsx')).not.toBeInTheDocument()
        expect(sessionChatMock).toHaveBeenCalledWith(expect.objectContaining({
            composerAppendText: '@/repo/src/App.tsx',
            onComposerAppendTextConsumed: onDraftConsumed
        }))
        const lastProps = sessionChatMock.mock.calls.at(-1)?.[0] as { onComposerAppendTextConsumed?: () => void }
        lastProps.onComposerAppendTextConsumed?.()
        expect(onDraftConsumed).toHaveBeenCalled()
    })

    it('remounts SessionChat when switching sessions so chat state does not accumulate', () => {
        const api = {} as ApiClient
        useSessionMock.mockReturnValueOnce({
            session: makeSession({ id: 'session-1' }),
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })
        const { rerender } = render(<EditorChatPanel api={api} sessionId="session-1" />)

        expect(screen.getByText('Session Chat session-1')).toBeInTheDocument()
        expect(sessionChatLifecycle.mounts).toBe(1)

        useSessionMock.mockReturnValueOnce({
            session: makeSession({ id: 'session-2' }),
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })
        rerender(<EditorChatPanel api={api} sessionId="session-2" />)

        expect(screen.getByText('Session Chat session-2')).toBeInTheDocument()
        expect(sessionChatLifecycle.unmounts).toBe(1)
        expect(sessionChatLifecycle.mounts).toBe(2)
    })
})
