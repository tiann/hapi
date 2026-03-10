import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import type { GitStatusFiles } from '@/types/api'
import { SessionChat } from './SessionChat'

const refetchSpy = vi.fn()
const gitStateBySessionId = new Map<string, { status: GitStatusFiles | null; error: string | null; isLoading: boolean }>()
let lastGitSummary: GitStatusFiles | null = null
let lastGitBranch: string | null = null
let lastGitError = false

vi.mock('@/hooks/queries/useGitStatusFiles', () => ({
    useGitStatusFiles: (_api: unknown, sessionId: string | null) => {
        const state = gitStateBySessionId.get(sessionId ?? 'none') ?? {
            status: null,
            error: null,
            isLoading: false,
        }
        return {
            ...state,
            refetch: refetchSpy,
        }
    }
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

vi.mock('@/components/SessionHeader', () => ({
    SessionHeader: (props: { gitSummary?: GitStatusFiles | null; gitLoading?: boolean; gitError?: boolean }) => {
        lastGitSummary = props.gitSummary ?? null
        lastGitBranch = props.gitSummary?.branch ?? null
        lastGitError = props.gitError ?? false
        return <div data-testid="session-header" />
    }
}))

vi.mock('@/components/TeamPanel', () => ({
    TeamPanel: () => null,
}))

vi.mock('@/components/AssistantChat/HappyComposer', () => ({
    HappyComposer: () => <div data-testid="happy-composer" />,
}))

vi.mock('@/components/AssistantChat/HappyThread', () => ({
    HappyThread: () => <div data-testid="happy-thread" />,
}))

vi.mock('@/lib/assistant-runtime', () => ({
    useHappyRuntime: () => ({}),
}))

vi.mock('@/lib/attachmentAdapter', () => ({
    createAttachmentAdapter: () => null,
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: {
            notification: vi.fn(),
        }
    })
}))

vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({
        abortSession: vi.fn(),
        switchSession: vi.fn(),
        setPermissionMode: vi.fn(),
        setModelMode: vi.fn(),
    })
}))

vi.mock('@/chat/normalize', () => ({
    normalizeDecryptedMessage: vi.fn(() => null),
}))

vi.mock('@/chat/reducer', () => ({
    reduceChatBlocks: () => ({ blocks: [], latestUsage: null }),
}))

vi.mock('@/chat/reconcile', () => ({
    reconcileChatBlocks: () => ({ blocks: [], byId: new Map() }),
}))

vi.mock('@assistant-ui/react', async () => {
    const ReactModule = await import('react')
    return {
        AssistantRuntimeProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
    }
})

const baseProps = {
    api: {} as never,
    messages: [],
    messagesWarning: null,
    hasMoreMessages: false,
    isLoadingMessages: false,
    isLoadingMoreMessages: false,
    isSending: false,
    pendingCount: 0,
    messagesVersion: 0,
    onBack: vi.fn(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(async () => ({})),
    onSend: vi.fn(),
    onFlushPending: vi.fn(),
    onAtBottomChange: vi.fn(),
}

function buildSession(id: string) {
    return {
        id,
        active: true,
        metadata: { path: '/tmp/project', flavor: 'claude' },
        agentState: {},
        permissionMode: 'ask',
        modelMode: 'default',
        thinking: false,
        teamState: null,
    } as never
}

describe('SessionChat git status cache', () => {
    it('clears cached summary and refetches on session change', () => {
        refetchSpy.mockClear()
        gitStateBySessionId.clear()
        lastGitSummary = null
        lastGitBranch = null
        lastGitError = false

        gitStateBySessionId.set('session-a', {
            status: {
                branch: 'main',
                totalStaged: 1,
                totalUnstaged: 2,
                stagedFiles: [],
                unstagedFiles: [],
            },
            error: null,
            isLoading: false,
        })

        const { rerender } = render(
            <SessionChat
                {...baseProps}
                session={buildSession('session-a')}
            />
        )

        expect(lastGitBranch).toBe('main')

        gitStateBySessionId.set('session-b', {
            status: null,
            error: 'Git status unavailable',
            isLoading: false,
        })

        rerender(
            <SessionChat
                {...baseProps}
                session={buildSession('session-b')}
            />
        )

        expect(lastGitSummary).toBeNull()
        expect(lastGitError).toBe(true)
        expect(refetchSpy).toHaveBeenCalledTimes(2)
    })
})
