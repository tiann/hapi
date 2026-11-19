import type { PermissionDecisionResponse } from '@hapi/protocol/apiTypes'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider, skipToken, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '@/App'
import { ApiError, type ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { createQueryClient } from '@/lib/query-client'
import { queryKeys } from '@/lib/query-keys'
import { refreshSessionDetailPreservingActive } from '@/lib/session-detail-optimistic'
import { applySessionDetailPatch } from '@/lib/sessionPatch'
import type { DecryptedMessage, Session, SessionResponse } from '@/types/api'
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

const detailKey = queryKeys.session('session-1')

function CachedChat({ renderChat }: { renderChat: (agentState: Session['agentState']) => ReactNode }) {
    const { data } = useQuery<SessionResponse>({ queryKey: detailKey, queryFn: skipToken })
    return data ? renderChat(data.session.agentState) : null
}

function setup(fromCache = false) {
    shell.api.approvePermission.mockReset().mockImplementation(
        async (_sessionId, requestId: string, options: { instanceId?: string }) => ({
            ok: true, acknowledgement: options.instanceId ? { requestId, instanceId: options.instanceId } : undefined
        })
    )
    const onRefresh = vi.fn()
    const onInitialPendingRequestConsumed = vi.fn()
    const queryClient = createQueryClient()
    const app = () => <QueryClientProvider client={queryClient}><I18nProvider><App /></I18nProvider></QueryClientProvider>
    const renderChat = (agentState: Session['agentState'], pendingRequestId?: string) => (
        <SessionChat
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
            initialPendingRequestId={pendingRequestId}
            onInitialPendingRequestConsumed={onInitialPendingRequestConsumed}
            onLoadMore={async () => ({ kind: 'stopped', reason: 'unavailable' })}
            onCancelLoadMore={() => {}}
            onSend={async () => false}
            onViewModeChange={() => {}}
            onJumpToTail={() => {}}
        />
    )
    let agentStateVersion = 0
    const setState = (agentState: Session['agentState'], mounted = true, pendingRequestId?: string) => {
        queryClient.setQueryData(detailKey, {
            session: { id: 'session-1', active: true, agentStateVersion: ++agentStateVersion, agentState }
        })
        shell.outlet = mounted ? renderChat(agentState, pendingRequestId) : null
    }
    if (fromCache) shell.outlet = <CachedChat renderChat={renderChat} />
    else setState(state('first'))
    const view = render(app())
    const update = (agentState: Session['agentState'], mounted = true, pendingRequestId?: string) => {
        setState(agentState, mounted, pendingRequestId)
        view.rerender(app())
    }
    const transcript = () => within(view.container.querySelector(`[data-hapi-source-message-id="tool-call:${requestId}"]`)!)
    const submit = async () => {
        await waitFor(() => expect(transcript().getByRole('button', { name: 'Submit' })).toBeVisible())
        fireEvent.change(transcript().getByRole('textbox'), { target: { value: 'Web' } })
        fireEvent.click(transcript().getByRole('button', { name: 'Submit' }))
    }
    return { update, transcript, submit, onRefresh, onInitialPendingRequestConsumed, queryClient }
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
        expect(screen.getByText('Answer sent. Waiting for the agent.', { selector: 'span.whitespace-nowrap' })).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Awaiting your answer' })).not.toBeInTheDocument()
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

    it('keeps an accepted receipt when the resume detail GET arrives after question SSE', async () => {
        const { queryClient, submit, transcript } = setup(true)
        const before: SessionResponse = {
            session: { id: 'session-1', active: true, agentStateVersion: 1, agentState: {} } as Session
        }
        const delayed = Promise.withResolvers<SessionResponse>()
        queryClient.setQueryData(detailKey, before)
        const refresh = refreshSessionDetailPreservingActive(queryClient, 'session-1', () => delayed.promise)
        const issued = applySessionDetailPatch(before.session, { agentState: { version: 2, value: state('first') } })!
        act(() => { queryClient.setQueryData(detailKey, { session: issued }) })
        await submit()
        await waitFor(() => expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible())

        await act(async () => {
            delayed.resolve(before)
            await refresh
        })
        expect(queryClient.getQueryData<SessionResponse>(detailKey)?.session.agentStateVersion).toBe(2)
        expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible()
        expect(transcript().queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    })

    it.each([
        { ok: true },
        { ok: true, acknowledgement: { requestId: 'different', instanceId: 'first' } },
        { ok: true, acknowledgement: { requestId, instanceId: 'different' } },
    ])('refreshes without recording an unconfirmed answer for %o', async response => {
        const { transcript, submit, onRefresh } = setup()
        shell.api.approvePermission.mockResolvedValueOnce(response)
        await submit()
        await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
        expect(transcript().getByRole('button', { name: 'Submit' })).toBeEnabled()
        expect(transcript().queryByText('Answer sent. Waiting for the agent.')).not.toBeInTheDocument()
    })

    it('closes the transcript form on 404 and refreshes the session', async () => {
        const { transcript, submit, onRefresh } = setup()
        shell.api.approvePermission.mockRejectedValueOnce(new ApiError('Request not found', 404))
        await submit()
        await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
        expect(transcript().queryByRole('textbox')).not.toBeInTheDocument()
        expect(transcript().queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    })

    it('opens and focuses an answered panel card from a pending-request deep link', async () => {
        const { update, submit, transcript, onInitialPendingRequestConsumed } = setup()
        await submit()
        const waiting = 'Answer sent. Waiting for the agent.'
        await waitFor(() => expect(transcript().getByText(waiting)).toBeVisible())
        const panel = within(screen.getByRole('region', { name: waiting }))
        expect(panel.getByRole('button', { name: waiting })).toHaveAttribute('aria-expanded', 'false')

        update(state('first'), true, requestId)

        await waitFor(() => {
            expect(panel.getByRole('button', { name: waiting })).toHaveAttribute('aria-expanded', 'true')
            const row = panel.getByText('Which client?', { selector: 'summary' }).closest('details')
            expect(row).toHaveAttribute('open')
            expect(row).toHaveFocus()
            expect(within(row!).getByText('Web')).toBeVisible()
            expect(onInitialPendingRequestConsumed).toHaveBeenCalledOnce()
        })
        expect(screen.queryByRole('button', { name: 'Awaiting your answer' })).not.toBeInTheDocument()
    })

    it('shows the normal status and consumes a route target for a hidden issuance', async () => {
        const { update, submit, onRefresh, onInitialPendingRequestConsumed } = setup()
        expect(screen.getByRole('button', { name: 'Awaiting your answer' })).toBeVisible()
        shell.api.approvePermission.mockRejectedValueOnce(new ApiError('Request not found', 404))
        await submit()
        await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
        expect(screen.getByText('online', { exact: true })).toBeVisible()
        expect(screen.queryByRole('button', { name: 'Awaiting your answer' })).not.toBeInTheDocument()

        update(state('first'), true, requestId)
        await waitFor(() => expect(onInitialPendingRequestConsumed).toHaveBeenCalledOnce())
        expect(screen.queryByRole('region', { name: 'Awaiting your reply' })).not.toBeInTheDocument()

        update(state('replacement'))
        expect(screen.getByRole('button', { name: 'Awaiting your answer' })).toBeVisible()
    })

    it('keeps the panel answer on both surfaces when the transcript submission receives a late 404', async () => {
        const { transcript, submit, onRefresh } = setup()
        const panelResponse = Promise.withResolvers<PermissionDecisionResponse>()
        const transcriptResponse = Promise.withResolvers<PermissionDecisionResponse>()
        shell.api.approvePermission
            .mockReturnValueOnce(panelResponse.promise)
            .mockReturnValueOnce(transcriptResponse.promise)

        fireEvent.click(screen.getByRole('button', { name: 'Awaiting your reply 1' }))
        const summary = screen.getByText('Which client?', { selector: 'summary' })
        const panelRow = within(summary.parentElement!)
        fireEvent.click(summary)
        fireEvent.change(panelRow.getByRole('textbox'), { target: { value: 'Panel answer' } })
        fireEvent.click(panelRow.getByRole('button', { name: 'Submit' }))
        await submit()
        expect(shell.api.approvePermission).toHaveBeenCalledTimes(2)

        await act(async () => { panelResponse.resolve({ ok: true, acknowledgement: { requestId, instanceId: 'first' } }) })
        expect(transcript().getByText('Panel answer')).toBeVisible()
        expect(panelRow.getByText('Panel answer')).toBeVisible()

        await act(async () => { transcriptResponse.reject(new ApiError('Request not found', 404)) })
        expect(onRefresh).toHaveBeenCalledTimes(2)
        expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible()
        expect(transcript().getByText('Panel answer')).toBeVisible()
        expect(panelRow.getByText('Panel answer')).toBeVisible()
    })

    it('closes a superseded issuance on conflict even when refresh still returns it', async () => {
        const { update, transcript, submit, onRefresh } = setup()
        shell.api.approvePermission.mockRejectedValueOnce(new ApiError('Question was reissued', 409, 'codex_question_reissued'))
        await submit()
        await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce())
        expect(shell.api.approvePermission).toHaveBeenCalledWith('session-1', requestId, {
            instanceId: 'first', answers: { q: { answers: ['user_note: Web'] } }
        })
        update(state('first'))
        expect(transcript().queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Awaiting your reply 1' })).not.toBeInTheDocument()
        update(state('replacement'))
        await waitFor(() => expect(transcript().getByRole('textbox')).toHaveValue(''))
        await submit()
        await waitFor(() => expect(transcript().getByText('Answer sent. Waiting for the agent.')).toBeVisible())
        expect(shell.api.approvePermission).toHaveBeenLastCalledWith('session-1', requestId, {
            instanceId: 'replacement', answers: { q: { answers: ['user_note: Web'] } }
        })
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
