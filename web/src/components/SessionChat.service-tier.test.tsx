import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SessionChat } from './SessionChat'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'

vi.mock('@tanstack/react-router', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useNavigate: () => async () => {}
}))

class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
    ;(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub
}
if (typeof Element.prototype.scrollTo !== 'function') {
    Element.prototype.scrollTo = function scrollTo() {}
}


vi.mock('@/components/AssistantChat/HappyComposer', () => ({ HappyComposer: (props: {
    onServiceTierChange?: (tier: string) => Promise<void>; fastAvailable?: boolean; ultrafastAvailable?: boolean
}) => <button disabled={!props.onServiceTierChange} onClick={() => void props.onServiceTierChange?.('standard')}>
    Reset Standard / fast:{String(props.fastAvailable)} / ultra:{String(props.ultrafastAvailable)}
</button> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
    function shell(session: Session, catalog: ReturnType<typeof vi.fn>, setServiceTier: ReturnType<typeof vi.fn>): ReactNode {
        const api = {
            getMachineCodexModels: catalog,
            getSessionCodexModels: catalog,
            setServiceTier,
            fetchTranscriptionProviders: vi.fn(async () => [])
        } as unknown as ApiClient
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        return (
            <QueryClientProvider client={queryClient}>
                <I18nProvider>
                    <ToastProvider>
                        <SessionChat
                            api={api}
                            session={session}
                            messages={[]}
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
                            onRefresh={() => {}}
                            onLoadMore={async () => 'terminal-stop' as never}
                            onCancelLoadMore={() => {}}
                            onSend={async () => false}
                            onViewModeChange={() => {}}
                            onJumpToTail={() => {}}
                        />
                    </ToastProvider>
                </I18nProvider>
            </QueryClientProvider>
        )
    }


it.each(['empty', 'failure'])('allows Standard recovery when catalog is %s', async mode => {
    const catalog = mode === 'empty' ? vi.fn(async () => ({ success: true, models: [] })) : vi.fn(async () => { throw new Error('catalog unavailable') })
    const setServiceTier = vi.fn(async () => ({}))
    const session = { id: 'tier-session', active: true, thinking: false, serviceTier: 'ultrafast', model: 'gpt-6.2-sol',
        metadata: { flavor: 'codex', machineId: 'machine', path: '/project', host: 'test', startingMode: 'remote', capabilities: { concurrentClients: true } }
    } as unknown as Session
    render(shell(session, catalog, setServiceTier))
    await waitFor(() => expect(catalog).toHaveBeenCalled())
    const button = screen.getByRole('button', { name: 'Reset Standard / fast:false / ultra:false' })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(setServiceTier).toHaveBeenCalledWith('tier-session', 'standard'))
})

it('hides unverified attached Ultrafast while retaining Standard recovery', async () => {
    const catalog = vi.fn(async () => ({ success: true, models: [{ id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', supportsFastTier: false, serviceTiers: ['ultrafast'] }] }));
    const setServiceTier = vi.fn(async () => ({}));
    const session = { id: 'tier-session', active: true, serviceTier: 'ultrafast', model: 'gpt-6.2-sol', metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexRuntime: { kind: 'attached', bindingId: 'attached' }, capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, setServiceTier));
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Reset Standard / fast:false / ultra:false' }));
    await waitFor(() => expect(setServiceTier).toHaveBeenCalledWith('tier-session', 'standard'));
});
