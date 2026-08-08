import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { FleetUpgradePolicy } from '@hapi/protocol/upgradeChannel'
import type { Machine } from '@/types/api'
import {
    RunnerVersionSkewBanner,
    collectConfirmedAutoUpgradeToasts,
    listBannerSkewMachines,
    listSkewedMachines,
    machineCanAutoUpgrade,
    machineDisplayHost,
} from './RunnerVersionSkewBanner'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import {
    clearRunnerSkewTempDismiss,
    resetRunnerSkewBannerMemoryForTests,
    runnerSkewBannerScope,
    setRunnerSkewMinimized,
} from '@/lib/runnerSkewBannerState'
import { getTokenNamespace } from '@/lib/tokenNamespace'

const TEST_OFFER = {
    channel: 'npm' as const,
    targetVersion: '0.23.0',
    targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
    npmPackage: '@twsxtd/hapi',
}
type UpgradeInfoMockResult = { info: { offer: typeof TEST_OFFER; policy: FleetUpgradePolicy }; isLoading: boolean }
const useMachinesMock = vi.fn()
const useUpgradeInfoMock = vi.fn((..._args: unknown[]): UpgradeInfoMockResult => ({ info: { offer: TEST_OFFER, policy: 'alert' }, isLoading: false }))
const restartMachineRunnerMock = vi.fn(async (): Promise<{ message: string }> => ({ message: 'ok' }))
const upgradeMachineRunnerMock = vi.fn(async (): Promise<{ message: string; response?: unknown }> => ({ message: 'ok' }))
const useAppContextMock = vi.fn(() => ({
    api: {
        restartMachineRunner: restartMachineRunnerMock,
        upgradeMachineRunner: upgradeMachineRunnerMock,
    } as never,
    token: 't',
    baseUrl: 'http://localhost',
}))

vi.mock('@/hooks/queries/useMachines', () => ({
    useMachines: (...args: unknown[]) => useMachinesMock(...args),
}))

vi.mock('@/hooks/queries/useUpgradeInfo', () => ({
    useUpgradeInfo: (...args: unknown[]) => useUpgradeInfoMock(...args),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => useAppContextMock(),
}))

vi.mock('@/hooks/useOnlineStatus', () => ({
    useOnlineStatus: () => true,
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        haptic: { impact: vi.fn(), notification: vi.fn() },
    }),
}))

function makeMachine(overrides: Partial<Machine> & { id: string }): Machine {
    const { id, ...rest } = overrides
    return {
        id,
        namespace: 'default',
        seq: 1,
        createdAt: 0,
        updatedAt: 0,
        active: rest.active ?? true,
        activeAt: Date.now(),
        metadata: rest.metadata ?? {
            host: 'proxmox',
            platform: 'linux',
            happyCliVersion: '0.20.0',
        },
        metadataVersion: 1,
        runnerState: null,
        runnerStateVersion: 0,
        ...rest,
    } as Machine
}

function makeUpgradeableMachine(overrides: Partial<Machine> & { id: string }): Machine {
    return makeMachine({
        ...overrides,
        metadata: {
            host: 'proxmox',
            platform: 'linux',
            happyCliVersion: '0.20.0',
            ...overrides.metadata,
            capabilities: overrides.metadata?.capabilities
                ?? [...CURRENT_MACHINE_CAPABILITIES],
        },
    })
}

function renderBanner() {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    return render(
        <QueryClientProvider client={client}>
            <I18nProvider>
                <ToastProvider>
                    <RunnerVersionSkewBanner />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>,
    )
}

describe('collectConfirmedAutoUpgradeToasts', () => {
    it('does not toast when a skewed auto-eligible runner merely goes offline', () => {
        const offline = makeUpgradeableMachine({
            id: 'win',
            active: false,
            metadata: { host: 'personal-win', platform: 'win32', happyCliVersion: '0.20.0' },
        })
        const result = collectConfirmedAutoUpgradeToasts({
            previousAutoSkewIds: new Set(['win']),
            machines: [offline],
            offer: TEST_OFFER,
        })
        expect(result.toastHosts).toEqual([])
        expect(result.nextAutoSkewIds.has('win')).toBe(true)

        const caughtUp = makeUpgradeableMachine({
            id: 'win',
            metadata: {
                host: 'personal-win',
                platform: 'win32',
                happyCliVersion: '0.23.0',
                capabilities: [...CURRENT_MACHINE_CAPABILITIES],
            },
        })
        expect(collectConfirmedAutoUpgradeToasts({
            previousAutoSkewIds: new Set(['win']),
            machines: [caughtUp],
            offer: TEST_OFFER,
        }).toastHosts).toEqual(['personal-win'])
    })

    it('keeps pending IDs when the machine is missing from the online-only list', () => {
        const result = collectConfirmedAutoUpgradeToasts({
            previousAutoSkewIds: new Set(['win']),
            machines: [],
            offer: TEST_OFFER,
        })
        expect(result.toastHosts).toEqual([])
        expect(result.nextAutoSkewIds.has('win')).toBe(true)
    })
})

describe('listBannerSkewMachines', () => {
    it('under auto, keeps self-upgradeable hosts visible for failed-upgrade recovery', () => {
        const upgradeable = makeUpgradeableMachine({
            id: 'ok',
            metadata: { host: 'homelab', platform: 'linux', happyCliVersion: '0.20.0' },
        })
        const legacy = makeMachine({
            id: 'legacy',
            metadata: {
                host: 'old-box',
                platform: 'linux',
                happyCliVersion: '0.20.0',
                capabilities: [],
            },
        })
        expect(machineCanAutoUpgrade(upgradeable)).toBe(true)
        expect(machineCanAutoUpgrade(legacy)).toBe(false)
        // Permanent upgrade_failed only toasts today — do not hide the recovery UI.
        expect(listBannerSkewMachines([upgradeable, legacy], TEST_OFFER, 'auto').map((m) => m.id)).toEqual(['ok', 'legacy'])
        expect(listBannerSkewMachines([upgradeable, legacy], TEST_OFFER, 'alert').map((m) => m.id)).toEqual(['ok', 'legacy'])
        expect(listBannerSkewMachines([upgradeable, legacy], TEST_OFFER, 'silent')).toEqual([])
    })
})

describe('listSkewedMachines', () => {
    it('flags online machines that trail the hub offer (version or capability drift)', () => {
        const skewed = listSkewedMachines([
            makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            makeMachine({
                id: 'new',
                metadata: {
                    host: 'oos',
                    platform: 'linux',
                    happyCliVersion: '0.23.0',
                    capabilities: [...CURRENT_MACHINE_CAPABILITIES],
                },
            }),
            makeMachine({
                id: 'offline-old',
                active: false,
                metadata: { host: 'ha', platform: 'linux', happyCliVersion: '0.19.0' },
            }),
        ], TEST_OFFER)
        expect(skewed.map((m) => m.id)).toEqual(['old'])
    })

    it('returns nothing without an offer', () => {
        expect(listSkewedMachines([
            makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
        ], null)).toEqual([])
    })

    it('includes versionHandoffDisabled machines so Restart stays visible', () => {
        const skewed = listSkewedMachines([
            makeMachine({
                id: 'soup',
                metadata: {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.20.0',
                    versionHandoffDisabled: true,
                },
            }),
            makeMachine({
                id: 'binary',
                metadata: { host: 'teemo', platform: 'win32', happyCliVersion: '0.20.0' },
            }),
        ], TEST_OFFER)
        expect(skewed.map((m) => m.id)).toEqual(['soup', 'binary'])
    })

    it('does not forever-trail handoff-disabled hosts on generation-only drift', () => {
        const artifactOffer = {
            channel: 'hub-artifact' as const,
            targetVersion: '0.23.0',
            targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
            targetGeneration: 'gen-soup',
            artifact: {
                url: '/cli/upgrade/cli-artifact',
                sha256: 'abc',
                platform: 'linux',
                arch: 'x64',
                sizeBytes: 1,
            },
        }
        const skewed = listSkewedMachines([
            makeMachine({
                id: 'soup-current',
                metadata: {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.23.0',
                    capabilities: [...CURRENT_MACHINE_CAPABILITIES],
                    versionHandoffDisabled: true,
                    // no cliArtifactGeneration — soup hosts never write a marker
                },
            }),
            makeMachine({
                id: 'soup-mtime',
                metadata: {
                    host: 'proxmox',
                    platform: 'linux',
                    happyCliVersion: '0.23.0',
                    capabilities: [...CURRENT_MACHINE_CAPABILITIES],
                    versionHandoffDisabled: true,
                    startedCliMtimeMs: 100,
                    installedCliMtimeMs: 200,
                },
            }),
            makeMachine({
                id: 'binary-drift',
                metadata: {
                    host: 'teemo',
                    platform: 'win32',
                    happyCliVersion: '0.23.0',
                    capabilities: [...CURRENT_MACHINE_CAPABILITIES],
                    // missing generation — handoff-enabled must still trail
                },
            }),
        ], artifactOffer)
        expect(skewed.map((m) => m.id)).toEqual(['soup-mtime', 'binary-drift'])
    })

    it('uses displayName when present', () => {
        expect(machineDisplayHost(makeMachine({
            id: 'm1',
            metadata: {
                host: 'proxmox.local',
                platform: 'linux',
                happyCliVersion: '0.20.0',
                displayName: 'Proxmox box',
            },
        }))).toBe('Proxmox box')
    })
})

describe('RunnerVersionSkewBanner', () => {
    beforeEach(() => {
        window.sessionStorage.clear()
        resetRunnerSkewBannerMemoryForTests()
        const scope = runnerSkewBannerScope('http://localhost', getTokenNamespace('t'))
        setRunnerSkewMinimized(scope, false)
        clearRunnerSkewTempDismiss(scope)
        restartMachineRunnerMock.mockClear()
        upgradeMachineRunnerMock.mockClear()
        useUpgradeInfoMock.mockReturnValue({ info: { offer: TEST_OFFER, policy: 'alert' }, isLoading: false })
    })

    afterEach(() => {
        cleanup()
        vi.clearAllMocks()
    })

    it('disables Upgrade for handoff-disabled hosts and enables Restart only when supervised with newer binary', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({
                    id: 'soup',
                    metadata: {
                        host: 'proxmox',
                        platform: 'linux',
                        happyCliVersion: '0.20.0',
                        versionHandoffDisabled: true,
                        supervisedRestart: true,
                        startedCliMtimeMs: 100,
                        installedCliMtimeMs: 200,
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(screen.getByTestId('runner-version-skew-upgrade-soup')).toBeDisabled()
        expect(screen.getByTestId('runner-version-skew-restart-soup')).toBeEnabled()
    })

    it('keeps Restart disabled when handoff is disabled without supervisedRestart', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({
                    id: 'detached',
                    metadata: {
                        host: 'laptop',
                        platform: 'linux',
                        happyCliVersion: '0.20.0',
                        versionHandoffDisabled: true,
                        startedCliMtimeMs: 100,
                        installedCliMtimeMs: 200,
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(screen.getByTestId('runner-version-skew-upgrade-detached')).toBeDisabled()
        expect(screen.getByTestId('runner-version-skew-restart-detached')).toBeDisabled()
    })

    it('keeps Restart disabled when supervised but on-disk CLI is not newer', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({
                    id: 'same-bytes',
                    metadata: {
                        host: 'soup',
                        platform: 'linux',
                        happyCliVersion: '0.20.0',
                        versionHandoffDisabled: true,
                        supervisedRestart: true,
                        startedCliMtimeMs: 100,
                        installedCliMtimeMs: 100,
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(screen.getByTestId('runner-version-skew-restart-same-bytes')).toBeDisabled()
    })

    it('renders a compact banner with minimize and snooze actions', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(screen.getByTestId('runner-version-skew-banner')).toHaveAttribute('data-state', 'expanded')
        expect(screen.getByText(/1 machine\(s\) with outdated runners/)).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-minimize')).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-dismiss')).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-restart-old')).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-upgrade-old')).toBeInTheDocument()
    })

    it('minimizes so the strip stays small', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        fireEvent.click(screen.getByTestId('runner-version-skew-minimize'))
        expect(screen.getByTestId('runner-version-skew-banner')).toHaveAttribute('data-state', 'minimized')
        expect(screen.getByTestId('runner-version-skew-expand')).toBeInTheDocument()
    })

    it('temp-dismisses so sessions are reachable', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        fireEvent.click(screen.getByTestId('runner-version-skew-dismiss'))
        expect(screen.queryByTestId('runner-version-skew-banner')).not.toBeInTheDocument()
    })

    it('disables Upgrade for legacy runners without RunnerSelfUpgrade', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        const upgrade = screen.getByTestId('runner-version-skew-upgrade-old')
        expect(upgrade).toBeDisabled()
        expect(upgrade).toHaveAttribute('title', expect.stringMatching(/too old|self-upgrade|manual/i))
        expect(screen.getByText(/legacy runner/i)).toBeInTheDocument()
    })

    it('disables Restart on unsupervised hosts (Upgrade owns handoff relaunch)', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeUpgradeableMachine({
                    id: 'old',
                    metadata: {
                        host: 'proxmox',
                        platform: 'linux',
                        happyCliVersion: '0.20.0',
                        startedCliMtimeMs: 100,
                        installedCliMtimeMs: 200,
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        const restart = screen.getByTestId('runner-version-skew-restart-old')
        expect(restart).toBeDisabled()
        expect(restart).toHaveAttribute(
            'title',
            expect.stringMatching(/supervised|Upgrade/i),
        )
        expect(screen.getByTestId('runner-version-skew-upgrade-old')).toBeEnabled()
    })

    it('calls upgradeMachineRunner when Upgrade is clicked', async () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeUpgradeableMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        fireEvent.click(screen.getByTestId('runner-version-skew-upgrade-old'))
        await waitFor(() => {
            expect(upgradeMachineRunnerMock).toHaveBeenCalledWith('old')
        })
    })

    it('surfaces already-current instead of silent Upgrade flash', async () => {
        upgradeMachineRunnerMock.mockResolvedValueOnce({
            message: 'Already at 0.24.0',
            response: { status: 'already-current', message: 'Already at 0.24.0', channel: 'hub-artifact' },
        })
        useMachinesMock.mockReturnValue({
            machines: [
                makeUpgradeableMachine({ id: 'Teemo', metadata: { host: 'Teemo', platform: 'win32', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        fireEvent.click(screen.getByTestId('runner-version-skew-upgrade-Teemo'))
        await waitFor(() => {
            expect(screen.getByTestId('runner-version-skew-action-info')).toHaveTextContent('Already at 0.24.0')
        })
        expect(screen.queryByTestId('runner-version-skew-action-error')).toBeNull()
    })

    it('calls restartMachineRunner when Restart is clicked on a supervised host', async () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({
                    id: 'soup',
                    metadata: {
                        host: 'soup',
                        platform: 'linux',
                        happyCliVersion: '0.20.0',
                        versionHandoffDisabled: true,
                        supervisedRestart: true,
                        startedCliMtimeMs: 100,
                        installedCliMtimeMs: 200,
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        fireEvent.click(screen.getByTestId('runner-version-skew-restart-soup'))
        await waitFor(() => {
            expect(restartMachineRunnerMock).toHaveBeenCalledWith('soup')
        })
    })

    it('minimizes even when sessionStorage setItem throws QuotaExceededError', () => {
        const proto = Object.getPrototypeOf(window.sessionStorage) as Storage
        vi.spyOn(proto, 'setItem').mockImplementation(() => {
            throw new DOMException('quota', 'QuotaExceededError')
        })

        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(() => fireEvent.click(screen.getByTestId('runner-version-skew-minimize'))).not.toThrow()
        expect(screen.getByTestId('runner-version-skew-banner')).toHaveAttribute('data-state', 'minimized')
    })

    it('hides entirely when policy is silent, even with a drifted runner', async () => {
        useUpgradeInfoMock.mockReturnValue({ info: { offer: TEST_OFFER, policy: 'silent' }, isLoading: false })
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        await waitFor(() => {
            expect(screen.queryByTestId('runner-version-skew-banner')).not.toBeInTheDocument()
        })
    })

    it('under auto, still banners self-upgradeable hosts so upgrade_failed stays recoverable', async () => {
        useUpgradeInfoMock.mockReturnValue({ info: { offer: TEST_OFFER, policy: 'auto' }, isLoading: false })
        useMachinesMock.mockReturnValue({
            machines: [
                makeUpgradeableMachine({
                    id: 'win',
                    metadata: { host: 'personal-win', platform: 'win32', happyCliVersion: '0.20.0' },
                }),
                makeUpgradeableMachine({
                    id: 'lab',
                    metadata: { host: 'homelab', platform: 'linux', happyCliVersion: '0.20.0' },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(screen.getByTestId('runner-version-skew-banner')).toBeInTheDocument()
        expect(screen.getByText(/2 runner\(s\) need attention/)).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-banner-win')).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-banner-lab')).toBeInTheDocument()
    })

    it('under auto, banners both self-upgradeable and legacy skewed hosts', async () => {
        useUpgradeInfoMock.mockReturnValue({ info: { offer: TEST_OFFER, policy: 'auto' }, isLoading: false })
        useMachinesMock.mockReturnValue({
            machines: [
                makeUpgradeableMachine({
                    id: 'ok',
                    metadata: { host: 'homelab', platform: 'linux', happyCliVersion: '0.20.0' },
                }),
                makeMachine({
                    id: 'legacy',
                    metadata: {
                        host: 'old-box',
                        platform: 'linux',
                        happyCliVersion: '0.20.0',
                        capabilities: [],
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        expect(screen.getByTestId('runner-version-skew-banner')).toBeInTheDocument()
        expect(screen.getByText(/2 runner\(s\) need attention/)).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-banner-legacy')).toBeInTheDocument()
        expect(screen.getByTestId('runner-version-skew-banner-ok')).toBeInTheDocument()
    })

    it('hides when all online machines advertise required capabilities', async () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({
                    id: 'new',
                    metadata: {
                        host: 'oos',
                        platform: 'linux',
                        happyCliVersion: '0.23.0',
                        capabilities: [...CURRENT_MACHINE_CAPABILITIES],
                    },
                }),
            ],
            isLoading: false,
            error: null,
        })

        renderBanner()

        await waitFor(() => {
            expect(screen.queryByTestId('runner-version-skew-banner')).not.toBeInTheDocument()
        })
    })
})
