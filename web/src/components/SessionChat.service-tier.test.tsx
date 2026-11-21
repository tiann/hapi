import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { SessionChat } from './SessionChat'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { ApiError, type ApiClient } from '@/api/client'
import { RPC_TARGET_MISSING_ERROR_CODE } from '@hapi/protocol/rpcMethods'
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
    onModelChange?: (model: string) => Promise<void>; onServiceTierChange?: (tier: string) => Promise<void>; fastAvailable?: boolean; ultrafastAvailable?: boolean
    serviceTier?: string | null
}) => <><button onClick={() => void props.onModelChange?.('changed-model')}>Change model</button><button disabled={!props.onServiceTierChange} onClick={() => void props.onServiceTierChange?.('standard')}>
    Reset Standard / fast:{String(props.fastAvailable)} / ultra:{String(props.ultrafastAvailable)}
</button><span data-testid="effective-tier">{props.serviceTier ?? 'none'}</span></> }))
afterEach(() => { cleanup(); vi.restoreAllMocks() })
    function shell(session: Session, catalog: ReturnType<typeof vi.fn>, setServiceTier: ReturnType<typeof vi.fn>, sessionCatalog = catalog,
        queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })): ReactNode {
        const api = {
            getMachineCodexModels: catalog,
            getSessionCodexModels: sessionCatalog,
            setServiceTier,
            setModel: vi.fn(async () => { throw new Error('Catalog provider could not be verified. Switch to Standard before changing models.') }),
            fetchTranscriptionProviders: vi.fn(async () => [])
        } as unknown as ApiClient
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

it.each(['attached', 'owned'])('hides unverified %s Ultrafast while retaining Standard recovery', async kind => {
    const catalog = vi.fn(async () => ({ success: true, models: [{ id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', supportsFastTier: false, serviceTiers: ['ultrafast'] }] }));
    const setServiceTier = vi.fn(async () => ({}));
    const session = { id: 'tier-session', active: true, serviceTier: 'ultrafast', model: 'gpt-6.2-sol', metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexProviderScopedCatalog: false, codexRuntime: { kind, bindingId: 'attached' }, capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, setServiceTier));
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Reset Standard / fast:false / ultra:false' }));
    await waitFor(() => expect(setServiceTier).toHaveBeenCalledWith('tier-session', 'standard'));
});

it('displays the Standard recovery instruction when a model change fails', async () => {
    const catalog = vi.fn(async () => ({ success: true, models: [] }));
    const session = { id: 'tier-session', active: true, model: 'mock', serviceTier: 'ultrafast', metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexRuntime: { kind: 'attached', bindingId: 'attached' }, capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, vi.fn()));
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Switch to Standard before changing models.');
});

it.each(['attached', 'owned'])('offers %s Ultrafast when native provider-scoped discovery is verified', async kind => {
    const catalog = vi.fn(async () => ({ success: true, models: [{ id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', serviceTiers: ['ultrafast'] }] }));
    const session = { id: 'tier-session', active: true, model: 'gpt-6.2-sol', serviceTier: 'ultrafast', metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexProviderScopedCatalog: true,
        codexRuntime: { kind, bindingId: 'attached' }, capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, vi.fn()));
    expect(await screen.findByRole('button', { name: 'Reset Standard / fast:false / ultra:true' })).toBeTruthy();
});

it('withholds the previous runtime catalog when the same Codex session resumes', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const model = { id: 'gpt-6.2-sol', displayName: 'GPT-6.2 Sol', isDefault: true }
    let finishCatalog!: (result: { success: boolean; models: Array<typeof model & { serviceTiers: string[] }> }) => void
    const newCatalog = new Promise<Parameters<typeof finishCatalog>[0]>(resolve => { finishCatalog = resolve })
    const sessionCatalog = vi.fn().mockResolvedValueOnce({ success: true, models: [{ ...model, serviceTiers: ['ultrafast'] }] })
        .mockReturnValueOnce(newCatalog)
    const machineCatalog = vi.fn()
    const setTier = vi.fn()
    const session = { id: 'tier-session', active: true, model: model.id, serviceTier: 'fast', metadata: {
        flavor: 'codex', machineId: 'machine', hostPid: 100, hostStartMarker: 'first-runtime',
        codexProviderScopedCatalog: true, capabilities: { concurrentClients: true }
    } } as unknown as Session
    const view = render(shell(session, machineCatalog, setTier, sessionCatalog, queryClient))
    expect(await screen.findByRole('button', { name: 'Reset Standard / fast:false / ultra:true' })).toBeInTheDocument()
    expect(sessionCatalog).toHaveBeenCalledTimes(1)

    view.rerender(shell({ ...session, metadata: { ...session.metadata!, hostPid: 100, hostStartMarker: 'second-runtime' } },
        machineCatalog, setTier, sessionCatalog, queryClient))
    expect(screen.getByRole('button', { name: 'Reset Standard / fast:false / ultra:false' })).toBeEnabled()
    await waitFor(() => expect(sessionCatalog).toHaveBeenCalledTimes(2))
    finishCatalog({ success: true, models: [{ ...model, serviceTiers: ['priority'] }] })
    expect(await screen.findByRole('button', { name: 'Reset Standard / fast:true / ultra:false' })).toBeEnabled()
    expect(sessionCatalog.mock.calls).toEqual([['tier-session'], ['tier-session']])
    expect(machineCatalog).not.toHaveBeenCalled()
})

it('keeps Standard recovery available for a paused launch without a usable tier catalog', async () => {
    const catalog = vi.fn(async () => ({ success: true, models: [] }));
    const setServiceTier = vi.fn(async () => ({}));
    const session = { id: 'tier-session', active: true, model: 'mock', serviceTier: null, metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexTierConfirmationPending: true,
        capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, setServiceTier));
    const button = await screen.findByRole('button', { name: 'Reset Standard / fast:false / ultra:false' });
    expect(button).toBeEnabled(); fireEvent.click(button);
    await waitFor(() => expect(setServiceTier).toHaveBeenCalledWith('tier-session', 'standard'));
});
it('withholds a catalog-derived Fast badge while the session tier needs recovery', async () => {
    const catalog = vi.fn(async () => ({ success: true, models: [
        { id: 'mock', isDefault: true, serviceTiers: ['priority'], defaultServiceTier: 'priority' }
    ] }));
    const session = { id: 'tier-session', active: true, model: 'mock', serviceTier: null, metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexTierConfirmationPending: true,
        capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, vi.fn()));
    expect(await screen.findByRole('button', { name: 'Reset Standard / fast:true / ultra:false' })).toBeEnabled();
    expect(screen.getByTestId('effective-tier')).toHaveTextContent('none');
});
it('does not offer a tier control solely from an unverified owned Ultrafast catalog', async () => {
    const catalog = vi.fn(async () => ({ success: true, models: [{ id: 'gpt-6.2-sol', model: 'gpt-6.2-sol', serviceTiers: ['ultrafast'] }] }));
    const session = { id: 'tier-session', active: true, model: 'gpt-6.2-sol', serviceTier: 'standard', metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexProviderScopedCatalog: false,
        capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, vi.fn()));
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Reset Standard / fast:false / ultra:false' })).toBeDisabled();
});

it('does not offer Ultrafast from a machine fallback catalog and retains Standard recovery', async () => {
    const catalog = vi.fn(async () => ({ success: true, models: [{ id: 'gpt-6.2-sol', serviceTiers: ['ultrafast'] }] }));
    const sessionCatalog = vi.fn(async () => { throw new ApiError('missing', 503, RPC_TARGET_MISSING_ERROR_CODE); });
    const setTier = vi.fn(async () => ({}));
    const session = { id: 'tier-session', active: true, model: 'gpt-6.2-sol', serviceTier: 'ultrafast', metadata: {
        flavor: 'codex', machineId: 'machine', startingMode: 'remote', codexProviderScopedCatalog: true, capabilities: { concurrentClients: true }
    } } as unknown as Session;
    render(shell(session, catalog, setTier, sessionCatalog));
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Reset Standard / fast:false / ultra:false' }));
    await waitFor(() => expect(setTier).toHaveBeenCalledWith('tier-session', 'standard'));
});
