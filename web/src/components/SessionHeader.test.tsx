import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { DEFAULT_SESSION_HEADER_METADATA } from '@/hooks/useSessionHeaderMetadata'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { resolveSessionHeaderMachineLabel, SessionHeader } from './SessionHeader'

afterEach(() => {
    cleanup()
    localStorage.clear()
})

function ToastMessages() {
    const { toasts } = useToast()
    return <>{toasts.map((toast) => <div key={toast.id}>{toast.title}: {toast.body}</div>)}</>
}

function baseSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: { flavor: 'codex', path: '/repo', host: 'machine' },
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        ...overrides
    }
}

function renderHeader(session: Session, extra?: { serviceTier?: string | null; titleSuggestionAvailable?: boolean }) {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <ToastProvider>
                <I18nProvider>
                    <SessionHeader
                        session={session}
                        serviceTier={extra?.serviceTier}
                        titleSuggestionAvailable={extra?.titleSuggestionAvailable}
                        onBack={vi.fn()}
                        api={null}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
}

function renderAgentHeader(preferences: Partial<typeof DEFAULT_SESSION_HEADER_METADATA>) {
    localStorage.setItem('hapi-session-header-metadata', JSON.stringify({
        ...DEFAULT_SESSION_HEADER_METADATA,
        machine: false,
        lastActive: false,
        model: false,
        reasoning: false,
        fastMode: false,
        createdAt: false,
        updatedAt: false,
        worktree: false,
        ...preferences,
    }))
    return renderHeader(baseSession())
}

describe('resolveSessionHeaderMachineLabel', () => {
    it('prefers cached/display labels, then host, then short machine id', () => {
        expect(resolveSessionHeaderMachineLabel(
            baseSession({ metadata: { flavor: 'cursor', path: '/r', host: 'host.local', machineId: 'abc123456789' } }),
            { abc123456789: 'Workstation' }
        )).toBe('Workstation')

        expect(resolveSessionHeaderMachineLabel(
            baseSession({ metadata: { flavor: 'cursor', path: '/r', host: 'host.local', machineId: 'abc123456789' } }),
            {}
        )).toBe('host.local')

        expect(resolveSessionHeaderMachineLabel(
            baseSession({ metadata: { flavor: 'cursor', path: '/r', host: '', machineId: 'abc123456789' } }),
            {}
        )).toBe('abc12345')

        expect(resolveSessionHeaderMachineLabel(
            baseSession({ metadata: { flavor: 'cursor', path: '/r', host: '' } }),
            {}
        )).toBeNull()
    })
})

describe('SessionHeader', () => {
    it('shows the Agent icon and text by default', () => {
        renderHeader(baseSession())

        expect(screen.getAllByTestId('session-header-agent-icon')).toHaveLength(2)
        expect(screen.getAllByText('codex', { exact: true })).toHaveLength(2)
    })

    it('hides only the Agent icon when its preference is disabled', () => {
        renderAgentHeader({ agentIcon: false, agent: true })

        expect(screen.queryByTestId('session-header-agent-icon')).not.toBeInTheDocument()
        expect(screen.getAllByText('codex', { exact: true })).toHaveLength(2)
    })

    it('shows only the Agent icon when the Agent text preference is disabled', () => {
        renderAgentHeader({ agentIcon: true, agent: false })

        const agentIcons = screen.getAllByTestId('session-header-agent-icon')
        expect(agentIcons).toHaveLength(2)
        expect(agentIcons[0]?.parentElement).toHaveClass('-mr-1')
        expect(agentIcons[1]?.parentElement).toHaveClass('-mr-2')
        expect(screen.queryAllByText('codex', { exact: true })).toHaveLength(0)
    })

    it('hides both Agent details when both preferences are disabled', () => {
        renderAgentHeader({ agentIcon: false, agent: false })

        expect(screen.queryByTestId('session-header-agent-icon')).not.toBeInTheDocument()
        expect(screen.queryAllByText('codex', { exact: true })).toHaveLength(0)
    })

    it('hides title generation when the Hub does not advertise the capability', () => {
        const api = {
            getMachines: vi.fn().mockResolvedValue({ machines: [] }),
            getScratchlist: vi.fn().mockResolvedValue({ entries: [] })
        } as unknown as ApiClient

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={baseSession()}
                            onBack={vi.fn()}
                            api={api}
                            titleSuggestionAvailable={false}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByTitle('More actions'))
        fireEvent.click(screen.getByRole('menuitem', { name: /Rename/ }))

        expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument()
    })

    it('manually syncs an inactive Pi session through its owning machine', async () => {
        const importPiSessions = vi.fn().mockResolvedValue({
            success: true,
            results: [{ piSessionId: 'pi-native-1', hapiSessionId: 'session-1', action: 'updated', appended: 2 }]
        })
        const api = {
            getMachines: vi.fn().mockResolvedValue({ machines: [] }),
            importPiSessions
        } as unknown as import('@/api/client').ApiClient
        const queryClient = new QueryClient()
        const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
        render(
            <QueryClientProvider client={queryClient}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={baseSession({
                                active: false,
                                metadata: {
                                    flavor: 'pi',
                                    path: '/repo',
                                    host: 'machine',
                                    machineId: 'machine-1',
                                    piSessionId: 'pi-native-1'
                                }
                            })}
                            onBack={vi.fn()}
                            api={api}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /More/ }))
        fireEvent.click(screen.getByRole('menuitem', { name: /Sync Pi history/ }))

        await waitFor(() => expect(importPiSessions).toHaveBeenCalledWith({
            sessionIds: ['pi-native-1'],
            cwd: '/repo',
            machineId: 'machine-1'
        }))
        expect(invalidateQueries).toHaveBeenCalledTimes(3)
    })

    it('does not offer manual Pi sync while the HAPI session is active', () => {
        const api = {
            getMachines: vi.fn().mockResolvedValue({ machines: [] }),
            importPiSessions: vi.fn()
        } as unknown as import('@/api/client').ApiClient
        render(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={baseSession({
                                active: true,
                                metadata: { flavor: 'pi', path: '/repo', host: 'machine', machineId: 'machine-1', piSessionId: 'pi-native-1' }
                            })}
                            onBack={vi.fn()}
                            api={api}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: /More/ }))
        expect(screen.queryByRole('menuitem', { name: /Sync Pi history/ })).toBeNull()
    })

    it('renders and toggles the agent terminal control', () => {
        const onToggleTerminal = vi.fn()
        render(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={baseSession({ metadata: { flavor: 'agy', path: '/repo', host: 'machine' } })}
                            onBack={vi.fn()}
                            onToggleTerminal={onToggleTerminal}
                            terminalActive
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        const terminal = screen.getByRole('button', { name: 'Terminal' })
        expect(terminal).toHaveAttribute('aria-pressed', 'true')
        terminal.click()
        expect(onToggleTerminal).toHaveBeenCalledOnce()
    })

    it('shows an inherited catalog-default Fast tier', () => {
        renderHeader(baseSession(), { serviceTier: 'priority' })
        expect(screen.getByText('fast')).toBeInTheDocument()
        expect(screen.queryByText('reasoning default')).not.toBeInTheDocument()
    })

    it('shows Pi ordinary effort as reasoning metadata', () => {
        renderHeader(baseSession({
            metadata: { flavor: 'pi', path: '/repo', host: 'machine' },
            modelReasoningEffort: null,
            effort: 'max'
        }))

        expect(screen.getByTestId('session-header-reasoning')).toHaveTextContent('reasoning max')
    })

    it('keeps model reasoning effort for Codex and hides ordinary effort for non-Pi flavors', () => {
        const { rerender } = renderHeader(baseSession({
            modelReasoningEffort: 'xhigh',
            effort: 'max'
        }))

        expect(screen.getByTestId('session-header-reasoning')).toHaveTextContent('reasoning xhigh')

        rerender(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader
                            session={baseSession({
                                metadata: { flavor: 'claude', path: '/repo', host: 'machine' },
                                modelReasoningEffort: null,
                                effort: 'max'
                            })}
                            onBack={vi.fn()}
                            api={null}
                        />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        expect(screen.queryByTestId('session-header-reasoning')).not.toBeInTheDocument()
    })

    it('hides Pi reasoning metadata when the header reasoning setting is disabled', () => {
        localStorage.setItem('hapi-session-header-metadata', JSON.stringify({ reasoning: false }))
        renderHeader(baseSession({
            metadata: { flavor: 'pi', path: '/repo', host: 'machine' },
            effort: 'max'
        }))

        expect(screen.queryByTestId('session-header-reasoning')).not.toBeInTheDocument()
    })

    it('shows machine label and relative last-active age in the meta row', () => {
        const fiveMinutesAgo = Date.now() - 5 * 60_000
        renderHeader(baseSession({
            activeAt: fiveMinutesAgo,
            updatedAt: fiveMinutesAgo,
            metadata: {
                flavor: 'cursor',
                path: '/home/heavygee/coding/hapi',
                host: 'oos-linux',
                machineId: 'machine-deadbeef'
            }
        }))

        expect(screen.getByTestId('session-header-machine')).toHaveTextContent(/oos-linux/)
        expect(screen.getByTestId('session-header-age')).toHaveTextContent(/5m ago|5分钟前/)
    })

    it('advances relative age on the minute tick without a session prop change', () => {
        vi.useFakeTimers()
        const now = new Date('2026-07-29T16:00:00.000Z')
        vi.setSystemTime(now)

        try {
            renderHeader(baseSession({
                activeAt: now.getTime() - 30_000,
                updatedAt: now.getTime() - 30_000,
                metadata: { flavor: 'cursor', path: '/r', host: 'host.local' }
            }))

            expect(screen.getByTestId('session-header-age')).toHaveTextContent(/just now|刚刚/)

            act(() => {
                vi.advanceTimersByTime(60_000)
            })

            expect(screen.getByTestId('session-header-age')).toHaveTextContent(/1m ago|1分钟前/)
        } finally {
            vi.useRealTimers()
        }
    })

    it('anchors the action menu to the center of the More actions trigger', () => {
        renderHeader(baseSession())

        const moreButton = screen.getByTitle('More actions')
        const getBoundingClientRect = vi.spyOn(moreButton, 'getBoundingClientRect').mockReturnValue({
            bottom: 64,
            height: 32,
            left: 100,
            right: 132,
            top: 32,
            width: 32,
            x: 100,
            y: 32,
            toJSON: () => ({})
        } as DOMRect)

        try {
            fireEvent.click(moreButton)

            expect(screen.getByRole('menu').parentElement).toHaveStyle({ left: '116px' })
        } finally {
            getBoundingClientRect.mockRestore()
        }
    })

    it('toggles pin state from the header action menu', async () => {
        const setSessionPinMode = vi.fn().mockResolvedValue(undefined)
        const api = {
            getScratchlist: vi.fn().mockResolvedValue({ entries: [] }),
            setSessionPinMode
        } as unknown as ApiClient
        const session: Session = {
            id: 'session-pin',
            namespace: 'default',
            seq: 0,
            createdAt: 0,
            updatedAt: 0,
            active: false,
            activeAt: 0,
            metadata: { flavor: 'codex', path: '/repo', host: 'machine' },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0,
            model: null,
            modelReasoningEffort: null,
            effort: null,
            serviceTier: null,
            pinned: false,
            globalPinned: false
        }

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader session={session} onBack={vi.fn()} api={api} />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByTitle('More actions'))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Pin globally' }))

        await waitFor(() => expect(setSessionPinMode).toHaveBeenCalledWith('session-pin', 'global'))
    })

    it('shows an error toast when toggling the pin fails', async () => {
        const api = {
            getScratchlist: vi.fn().mockResolvedValue({ entries: [] }),
            setSessionPinMode: vi.fn().mockRejectedValue(new Error('Network unavailable'))
        } as unknown as ApiClient

        render(
            <QueryClientProvider client={new QueryClient()}>
                <ToastProvider>
                    <I18nProvider>
                        <SessionHeader session={baseSession({ pinned: false })} onBack={vi.fn()} api={api} />
                        <ToastMessages />
                    </I18nProvider>
                </ToastProvider>
            </QueryClientProvider>
        )

        fireEvent.click(screen.getByTitle('More actions'))
        fireEvent.click(screen.getByRole('menuitem', { name: 'Pin in project' }))

        expect(await screen.findByText('Could not update pin: Network unavailable')).toBeInTheDocument()
    })
})
