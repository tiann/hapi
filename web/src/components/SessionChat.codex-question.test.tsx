import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import type { DecryptedMessage, Session } from '@/types/api'
import { SessionChat } from './SessionChat'

const shell = vi.hoisted(() => ({
    api: {
        getHealth: vi.fn(async () => ({})),
        fetchTranscriptionProviders: vi.fn(async () => []),
        fetchVoiceBackend: vi.fn(async () => ({ backend: null, backends: [] })),
        approvePermission: vi.fn()
    },
    outlet: null as ReactNode,
    router: { history: { canGoBack: () => false, location: { pathname: '/sessions/session-1', search: '', hash: '', state: {} } } }
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Outlet: () => shell.outlet,
    useLocation: () => '/sessions/session-1',
    useMatchRoute: () => () => false,
    useNavigate: () => async () => {},
    useRouter: () => shell.router
}))
vi.mock('@/hooks/useAuthSource', () => ({
    useAuthSource: () => ({ authSource: { type: 'accessToken' }, isLoading: false })
}))
vi.mock('@/hooks/useAuth', () => ({
    useAuth: () => ({ api: shell.api, token: 'test-token', isLoading: false })
}))
vi.mock('@/components/AgentTerminal/AgentTerminalView', () => ({ AgentTerminalView: () => null }))
vi.mock('@/hooks/useSSE', () => ({
    useSSE: () => ({ subscriptionId: null })
}))

const requestId = 'codex-async-question:question'
const input = { isBlocking: false, questions: [{ id: 'q', question: 'Which client?', options: [] }] }
const messages: DecryptedMessage[] = [{
    id: 'message', seq: 1, localId: null, createdAt: 1_000,
    content: { role: 'agent', content: { type: 'codex', data: {
        type: 'tool-call', callId: requestId, name: 'request_user_input', input
    } } }
}]

function state(instance?: string): Session['agentState'] {
    const request = { tool: 'request_user_input', toolCallId: requestId, arguments: input, createdAt: 1_000, ...(instance === undefined ? {} : { instanceId: instance }) }
    return { requests: { [requestId]: request } }
}

function setup() {
    shell.api.approvePermission.mockReset().mockResolvedValue(undefined)
    const onRefresh = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const app = () => <QueryClientProvider client={queryClient}><I18nProvider><App /></I18nProvider></QueryClientProvider>
    const setState = (agentState: Session['agentState'], mounted = true) => {
        shell.outlet = mounted ? <SessionChat
            api={shell.api as unknown as ApiClient}
            session={{ id: 'session-1', active: true, agentState } as Session}
            messages={messages}
            messagesWarning={null}
            hasMoreMessages={false}
            isSyncingTail={false}
            isCatchingUpFromCache={false}
            isLoadingMoreMessages={false}
            isSending={false}
            viewMode="tail"
            messagesVersion={0}
            historyVersion={0}
            tailRevision={0}
            onBack={() => {}}
            onRefresh={onRefresh}
            onLoadMore={async () => ({ kind: 'stopped', reason: 'unavailable' })}
            onCancelLoadMore={() => {}}
            onSend={async () => false}
            onViewModeChange={() => {}}
            onJumpToTail={() => {}}
        /> : null
    }
    setState(state('first'))
    const view = render(app())
    const update = (agentState: Session['agentState'], mounted = true) => {
        setState(agentState, mounted)
        view.rerender(app())
    }
    const transcript = () => within(view.container.querySelector(`[data-hapi-source-message-id="tool-call:${requestId}"]`)!)
    const submit = async () => {
        await waitFor(() => expect(transcript().getByRole('button', { name: 'Submit' })).toBeVisible())
        fireEvent.change(transcript().getByRole('textbox'), { target: { value: 'Web' } })
        fireEvent.click(transcript().getByRole('button', { name: 'Submit' }))
    }
    return { update, transcript, submit, onRefresh }
}

describe('Codex question receipts in the session chat', () => {
    beforeEach(() => {
        vi.stubGlobal('ResizeObserver', class {
            observe() {}
            unobserve() {}
            disconnect() {}
        })
        if (typeof Element.prototype.scrollTo !== 'function') Element.prototype.scrollTo = () => {}
    })
    afterEach(() => vi.unstubAllGlobals())

    it('keeps the transcript receipt through an unknown snapshot and prunes it on authoritative removal', async () => {
        const { update, transcript, submit } = setup()
        await submit()
        await waitFor(() => expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible())
        expect(transcript().queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
        expect(transcript().getByText('Web')).toBeVisible()
        update(null)
        await waitFor(() => expect(transcript().queryByText('Answer sent. Waiting for the agent.')).not.toBeInTheDocument())
        update(state('first'))
        await waitFor(() => expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible())
        update({})
        await waitFor(() => expect(transcript().queryByText('Answer sent. Waiting for the agent.')).not.toBeInTheDocument())
        update(state('first'))
        await waitFor(() => expect(transcript().getByRole('button', { name: 'Submit' })).toBeVisible())
    })

    it.each([false, true])('allows a restored same-ID question without an absent snapshot (unmounted: %s)', async (unmounted) => {
        const { update, transcript, submit } = setup()
        await submit()
        await waitFor(() => expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible())
        if (unmounted) update(null, false)
        update(state('restored'))
        await waitFor(() => expect(transcript().getByRole('button', { name: 'Submit' })).toBeVisible())
        expect(screen.getByRole('button', { name: 'Awaiting your reply 1' })).toBeVisible()
        await submit()
        await waitFor(() => expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible())
    })

    it('closes the transcript form on 404 and refreshes the session', async () => {
        const { transcript, submit, onRefresh } = setup()
        shell.api.approvePermission.mockRejectedValueOnce(new ApiError('Request not found', 404))
        await submit()
        await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
        expect(transcript().queryByRole('textbox')).not.toBeInTheDocument()
        expect(transcript().queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    })

    it('waits for hub state when an older runner omits the issuance ID', async () => {
        const { update, transcript, submit, onRefresh } = setup()
        update(state())
        await submit()
        await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
        expect(transcript().getByRole('button', { name: 'Submit' })).toBeEnabled()
        expect(transcript().queryByText('Answer sent. Waiting for the agent.')).not.toBeInTheDocument()

        shell.api.approvePermission.mockRejectedValueOnce(new ApiError('Request not found', 404))
        await submit()
        expect(await transcript().findByText('Request not found')).toBeVisible()
        expect(onRefresh).toHaveBeenCalledOnce()
        update({})
        await waitFor(() => expect(transcript().queryByRole('textbox')).not.toBeInTheDocument())
    })

    it('keeps the answer editable after a server error', async () => {
        const { transcript, submit, onRefresh } = setup()
        shell.api.approvePermission.mockRejectedValueOnce(new ApiError('Server error', 500))
        await submit()
        expect(await transcript().findByText('Server error')).toBeVisible()
        expect(transcript().getByRole('textbox')).toHaveValue('Web')
        expect(transcript().getByRole('button', { name: 'Submit' })).toBeEnabled()
        expect(onRefresh).not.toHaveBeenCalled()
    })
})
