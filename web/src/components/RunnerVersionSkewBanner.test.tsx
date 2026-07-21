import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CURRENT_MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import type { FleetUpgradePolicy } from '@hapi/protocol/upgradeChannel'
import type { Machine } from '@/types/api'
import {
    RunnerVersionSkewBanner,
    listSkewedMachines,
    machineDisplayHost,
} from './RunnerVersionSkewBanner'
import { I18nProvider } from '@/lib/i18n-context'
import {
    clearRunnerSkewTempDismiss,
    resetRunnerSkewBannerMemoryForTests,
    setRunnerSkewMinimized,
} from '@/lib/runnerSkewBannerState'

const TEST_OFFER = {
    channel: 'npm' as const,
    targetVersion: '0.23.0',
    targetCapabilities: [...CURRENT_MACHINE_CAPABILITIES],
    npmPackage: '@twsxtd/hapi',
}
type UpgradeInfoMockResult = { info: { offer: typeof TEST_OFFER; policy: FleetUpgradePolicy }; isLoading: boolean }
const useMachinesMock = vi.fn()
const useUpgradeInfoMock = vi.fn((..._args: unknown[]): UpgradeInfoMockResult => ({ info: { offer: TEST_OFFER, policy: 'auto' }, isLoading: false }))
const restartMachineRunnerMock = vi.fn(async () => ({ message: 'ok' }))
const upgradeMachineRunnerMock = vi.fn(async () => ({ message: 'ok' }))
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
        setRunnerSkewMinimized(false)
        clearRunnerSkewTempDismiss()
        restartMachineRunnerMock.mockClear()
        upgradeMachineRunnerMock.mockClear()
        useUpgradeInfoMock.mockReturnValue({ info: { offer: TEST_OFFER, policy: 'auto' }, isLoading: false })
    })

    afterEach(() => {
        cleanup()
        vi.clearAllMocks()
    })

    it('renders a compact banner with minimize and snooze actions', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        expect(screen.getByTestId('runner-version-skew-banner')).toHaveAttribute('data-state', 'expanded')
        expect(screen.getByText(/1 runner\(s\) out of date/)).toBeInTheDocument()
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

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

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

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByTestId('runner-version-skew-dismiss'))
        expect(screen.queryByTestId('runner-version-skew-banner')).not.toBeInTheDocument()
    })

    it('disables Restart when no newer CLI is on disk', () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        const restart = screen.getByTestId('runner-version-skew-restart-old')
        expect(restart).toBeDisabled()
        expect(screen.getByTestId('runner-version-skew-upgrade-old')).toBeEnabled()
    })

    it('calls upgradeMachineRunner when Upgrade is clicked', async () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({ id: 'old', metadata: { host: 'proxmox', platform: 'linux', happyCliVersion: '0.20.0' } }),
            ],
            isLoading: false,
            error: null,
        })

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByTestId('runner-version-skew-upgrade-old'))
        await waitFor(() => {
            expect(upgradeMachineRunnerMock).toHaveBeenCalledWith('old')
        })
    })

    it('calls restartMachineRunner when Restart is clicked and newer CLI is on disk', async () => {
        useMachinesMock.mockReturnValue({
            machines: [
                makeMachine({
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

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        fireEvent.click(screen.getByTestId('runner-version-skew-restart-old'))
        await waitFor(() => {
            expect(restartMachineRunnerMock).toHaveBeenCalledWith('old')
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

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

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

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        await waitFor(() => {
            expect(screen.queryByTestId('runner-version-skew-banner')).not.toBeInTheDocument()
        })
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

        render(
            <I18nProvider>
                <RunnerVersionSkewBanner />
            </I18nProvider>,
        )

        await waitFor(() => {
            expect(screen.queryByTestId('runner-version-skew-banner')).not.toBeInTheDocument()
        })
    })
})
