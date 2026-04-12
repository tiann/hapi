import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { OpenClawChatPage } from './OpenClawChatPage'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useHappyRuntime } from '@/lib/assistant-runtime'
import { useVoiceOptional } from '@/lib/voice-context'
import { useOpenClawConversation } from '@/hooks/queries/useOpenClawConversation'
import { useOpenClawMessages } from '@/hooks/queries/useOpenClawMessages'
import { useOpenClawState } from '@/hooks/queries/useOpenClawState'
import { useSendOpenClawMessage } from '@/hooks/mutations/useSendOpenClawMessage'
import { useResolveOpenClawApproval } from '@/hooks/mutations/useResolveOpenClawApproval'

const happyThreadMock = vi.fn()
const happyComposerMock = vi.fn()
const realtimeVoiceSessionMock = vi.fn()

vi.mock('@assistant-ui/react', () => ({
    AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div data-testid="runtime-provider">{children}</div>
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: vi.fn(),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: vi.fn(),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => ({
            'chat.settings': 'Settings',
            'tool.allow': 'Allow',
            'tool.deny': 'Deny',
        }[key] ?? key)
    }),
}))

vi.mock('@/lib/assistant-runtime', () => ({
    useHappyRuntime: vi.fn()
}))

vi.mock('@/lib/voice-context', () => ({
    useVoiceOptional: vi.fn()
}))

vi.mock('@/realtime', () => ({
    registerVoiceHooksStore: vi.fn(),
    RealtimeVoiceSession: (props: unknown) => {
        realtimeVoiceSessionMock(props)
        return <div data-testid="realtime-voice-session" />
    }
}))

vi.mock('@/components/AssistantChat/HappyThread', () => ({
    HappyThread: (props: unknown) => {
        happyThreadMock(props)
        return <div data-testid="happy-thread" />
    }
}))

vi.mock('@/components/AssistantChat/HappyComposer', () => ({
    HappyComposer: (props: unknown) => {
        happyComposerMock(props)
        return <div data-testid="happy-composer" />
    }
}))

vi.mock('@/hooks/queries/useOpenClawConversation', () => ({
    useOpenClawConversation: vi.fn(),
}))

vi.mock('@/hooks/queries/useOpenClawMessages', () => ({
    useOpenClawMessages: vi.fn(),
}))

vi.mock('@/hooks/queries/useOpenClawState', () => ({
    useOpenClawState: vi.fn(),
}))

vi.mock('@/hooks/mutations/useSendOpenClawMessage', () => ({
    useSendOpenClawMessage: vi.fn(),
}))

vi.mock('@/hooks/mutations/useResolveOpenClawApproval', () => ({
    useResolveOpenClawApproval: vi.fn(),
}))

const navigateMock = vi.fn()
const sendMessageMock = vi.fn()
const approveMock = vi.fn()
const denyMock = vi.fn()
const refetchMessagesMock = vi.fn()
const refetchStateMock = vi.fn()
const loadMoreMock = vi.fn()
const startVoiceMock = vi.fn()
const stopVoiceMock = vi.fn()
const toggleMicMock = vi.fn()

describe('OpenClawChatPage', () => {
    afterEach(() => {
        cleanup()
    })

    beforeEach(() => {
        vi.clearAllMocks()

        vi.mocked(useNavigate).mockReturnValue(navigateMock)
        vi.mocked(useAppContext).mockReturnValue({
            api: {} as never,
            token: 'token',
            baseUrl: 'http://localhost:3006'
        })
        vi.mocked(useVoiceOptional).mockReturnValue({
            status: 'disconnected',
            errorMessage: null,
            micMuted: false,
            currentSessionId: null,
            setStatus: vi.fn(),
            setMicMuted: vi.fn(),
            toggleMic: toggleMicMock,
            startVoice: startVoiceMock,
            stopVoice: stopVoiceMock
        })
        vi.mocked(useHappyRuntime).mockReturnValue({} as never)
        vi.mocked(useOpenClawConversation).mockReturnValue({
            conversation: {
                id: 'conv-1',
                title: 'OpenClaw',
                status: 'ready',
                createdAt: 1,
                updatedAt: 1
            },
            isLoading: false,
            error: null,
            refetch: vi.fn()
        })
        vi.mocked(useOpenClawMessages).mockReturnValue({
            messages: [{
                id: 'msg-1',
                conversationId: 'conv-1',
                role: 'assistant',
                text: 'hello from openclaw',
                createdAt: 1,
                status: 'completed'
            }],
            hasMore: false,
            isLoading: false,
            isLoadingMore: false,
            messagesVersion: 7,
            error: null,
            loadMore: loadMoreMock,
            refetch: refetchMessagesMock
        })
        vi.mocked(useOpenClawState).mockReturnValue({
            state: {
                conversationId: 'conv-1',
                connected: true,
                thinking: false,
                lastError: null,
                pendingApprovals: [{
                    id: 'req-1',
                    conversationId: 'conv-1',
                    title: 'Approve action',
                    description: 'Need approval',
                    status: 'pending',
                    createdAt: 2
                }]
            },
            isLoading: false,
            error: null,
            refetch: refetchStateMock
        })
        vi.mocked(useSendOpenClawMessage).mockReturnValue({
            sendMessage: sendMessageMock.mockResolvedValue(undefined),
            isPending: false,
            error: null
        })
        vi.mocked(useResolveOpenClawApproval).mockReturnValue({
            approve: approveMock.mockResolvedValue(undefined),
            deny: denyMock.mockResolvedValue(undefined),
            isPending: false,
            error: null
        })
    })

    it('renders OpenClaw header and wires shared chat components with OpenClaw-specific capabilities', () => {
        render(<OpenClawChatPage />)

        expect(screen.getByText('OpenClaw Channel')).toBeInTheDocument()
        expect(screen.getByText('Approve action')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Sessions' })).toBeInTheDocument()
        expect(screen.getByTestId('runtime-provider')).toBeInTheDocument()
        expect(screen.getByTestId('happy-thread')).toBeInTheDocument()
        expect(screen.getByTestId('happy-composer')).toBeInTheDocument()

        expect(happyThreadMock).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'conv-1',
            hasMoreMessages: false,
            pendingCount: 0,
            rawMessagesCount: 1,
            normalizedMessagesCount: 1,
            messagesVersion: 7,
            onLoadMore: loadMoreMock,
        }))
        expect(happyComposerMock).toHaveBeenCalledWith(expect.objectContaining({
            disabled: false,
            active: true,
            thinking: false,
            attachmentsEnabled: false,
            enableAbort: false,
            voiceStatus: 'disconnected',
            voiceMicMuted: false,
            onVoiceToggle: expect.any(Function),
            onVoiceMicToggle: expect.any(Function),
        }))
        expect(screen.getByTestId('realtime-voice-session')).toBeInTheDocument()
        expect(realtimeVoiceSessionMock).toHaveBeenCalledWith(expect.objectContaining({
            sendMessage: expect.any(Function)
        }))

        expect(useHappyRuntime).toHaveBeenCalledWith(expect.objectContaining({
            active: true,
            isRunning: false,
            isSending: false,
            allowSendWhenInactive: false,
            blocks: [expect.objectContaining({
                kind: 'agent-text',
                id: 'msg-1',
                text: 'hello from openclaw'
            })]
        }))
    })

    it('wires send and approval actions to the OpenClaw hooks', async () => {
        render(<OpenClawChatPage />)

        const runtimeArgs = vi.mocked(useHappyRuntime).mock.calls[0]?.[0]
        expect(runtimeArgs).toBeDefined()

        await runtimeArgs?.onSendMessage('hello from web')

        await waitFor(() => {
            expect(sendMessageMock).toHaveBeenCalledWith('conv-1', 'hello from web')
        })

        fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
        fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
        fireEvent.click(screen.getByRole('button', { name: 'Sessions' }))

        expect(approveMock).toHaveBeenCalledWith('conv-1', 'req-1')
        expect(denyMock).toHaveBeenCalledWith('conv-1', 'req-1')
        expect(navigateMock).toHaveBeenCalledWith({ to: '/sessions' })
    })
})
