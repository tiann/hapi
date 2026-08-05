import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@/types/api'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { resolveSessionHeaderMachineLabel, SessionHeader } from './SessionHeader'

afterEach(() => {
    cleanup()
    localStorage.clear()
})

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

function renderHeader(session: Session, extra?: { serviceTier?: string | null }) {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <ToastProvider>
                <I18nProvider>
                    <SessionHeader
                        session={session}
                        serviceTier={extra?.serviceTier}
                        onBack={vi.fn()}
                        api={null}
                    />
                </I18nProvider>
            </ToastProvider>
        </QueryClientProvider>
    )
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
})
