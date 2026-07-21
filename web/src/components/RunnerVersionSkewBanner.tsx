import { useCallback, useEffect, useState } from 'react'
import { cliBinaryUpdatedOnDisk } from '@hapi/protocol/runnerCapabilities'
import { DEFAULT_FLEET_UPGRADE_POLICY, machineTrailsUpgradeOffer, type HubUpgradeOffer } from '@hapi/protocol/upgradeChannel'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'
import { useUpgradeInfo } from '@/hooks/queries/useUpgradeInfo'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { usePlatform } from '@/hooks/usePlatform'
import {
    clearRunnerSkewTempDismiss,
    getRunnerSkewDismissUntil,
    isRunnerSkewMinimized,
    isRunnerSkewTempDismissed,
    setRunnerSkewMinimized,
    tempDismissRunnerSkew,
} from '@/lib/runnerSkewBannerState'

export function machineDisplayHost(machine: Machine): string {
    return machine.metadata?.displayName
        ?? machine.metadata?.host
        ?? machine.id
}

export function listSkewedMachines(machines: Machine[], offer: HubUpgradeOffer | null): Machine[] {
    if (!offer) {
        return []
    }
    return machines.filter((machine) => (
        machine.active
        && machineTrailsUpgradeOffer(offer, machine.metadata?.happyCliVersion, machine.metadata?.capabilities)
    ))
}

/**
 * Compact, minimizable skew banner (#1084).
 * Primary action: fleet Upgrade (npm or hub-artifact). Restart is escape hatch.
 */
export function RunnerVersionSkewBanner({ topClassName }: { topClassName?: string } = {}) {
    const { api } = useAppContext()
    const { machines } = useMachines(api, true)
    const { info } = useUpgradeInfo(api, true)
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()
    const policy = info?.policy ?? DEFAULT_FLEET_UPGRADE_POLICY
    const skewed = policy === 'silent' ? [] : listSkewedMachines(machines, info?.offer ?? null)
    const [minimized, setMinimized] = useState(() => isRunnerSkewMinimized())
    const [dismissed, setDismissed] = useState(() => isRunnerSkewTempDismissed())
    const [busyId, setBusyId] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)

    useEffect(() => {
        if (!dismissed) {
            return
        }
        const remaining = Math.max(0, getRunnerSkewDismissUntil() - Date.now())
        if (remaining === 0) {
            clearRunnerSkewTempDismiss()
            setDismissed(false)
            return
        }
        const timer = window.setTimeout(() => {
            clearRunnerSkewTempDismiss()
            setDismissed(false)
        }, remaining)
        return () => window.clearTimeout(timer)
    }, [dismissed])

    const onMinimize = useCallback(() => {
        haptic.impact('light')
        setMinimized(true)
        setRunnerSkewMinimized(true)
    }, [haptic])

    const onExpand = useCallback(() => {
        haptic.impact('light')
        setMinimized(false)
        setRunnerSkewMinimized(false)
    }, [haptic])

    const onTempDismiss = useCallback(() => {
        haptic.impact('light')
        setDismissed(true)
        tempDismissRunnerSkew()
    }, [haptic])

    const onUpgrade = useCallback(async (machine: Machine) => {
        if (!api) {
            return
        }
        haptic.impact('medium')
        setActionError(null)
        setBusyId(machine.id)
        try {
            await api.upgradeMachineRunner(machine.id)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : t('runner.skew.upgradeFailed'))
        } finally {
            setBusyId(null)
        }
    }, [api, haptic, t])

    const onRestart = useCallback(async (machine: Machine) => {
        if (!api) {
            return
        }
        haptic.impact('medium')
        setActionError(null)
        setBusyId(machine.id)
        try {
            await api.restartMachineRunner(machine.id)
        } catch (error) {
            setActionError(error instanceof Error ? error.message : t('runner.skew.restartFailed'))
        } finally {
            setBusyId(null)
        }
    }, [api, haptic, t])

    if (skewed.length === 0 || dismissed) {
        return null
    }

    const topClass = topClassName ?? (isOnline ? 'top-2' : 'top-10')
    const hosts = skewed.map(machineDisplayHost).join(', ')

    if (minimized) {
        return (
            <div
                data-testid="runner-version-skew-banner"
                data-state="minimized"
                className={`fixed left-4 right-4 z-40 ${topClass}`}
            >
                <button
                    type="button"
                    data-testid="runner-version-skew-expand"
                    onClick={onExpand}
                    className="w-full rounded-md border-2 border-amber-500 bg-amber-50 px-3 py-1.5 text-left text-xs font-medium text-amber-950 shadow dark:bg-amber-950/90 dark:text-amber-50"
                >
                    {t('runner.skew.banner.minimized', { count: skewed.length, hosts })}
                </button>
            </div>
        )
    }

    return (
        <div
            data-testid="runner-version-skew-banner"
            data-state="expanded"
            role="alert"
            className={`fixed left-4 right-4 z-40 max-h-[40vh] overflow-y-auto rounded-lg border-2 border-amber-500 bg-amber-50 p-3 shadow-lg dark:bg-amber-950/90 ${topClass}`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-amber-950 dark:text-amber-50">
                        {t('runner.skew.banner.summaryTitle', { count: skewed.length })}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
                        {t('runner.skew.banner.summaryBody')}
                    </p>
                </div>
                <div className="flex shrink-0 gap-1">
                    <button
                        type="button"
                        data-testid="runner-version-skew-minimize"
                        onClick={onMinimize}
                        className="rounded px-2 py-1 text-xs font-medium text-amber-950 hover:bg-amber-200/60 dark:text-amber-50 dark:hover:bg-amber-900"
                    >
                        {t('runner.skew.banner.minimize')}
                    </button>
                    <button
                        type="button"
                        data-testid="runner-version-skew-dismiss"
                        onClick={onTempDismiss}
                        className="rounded px-2 py-1 text-xs font-medium text-amber-950 hover:bg-amber-200/60 dark:text-amber-50 dark:hover:bg-amber-900"
                    >
                        {t('runner.skew.banner.dismissTemp')}
                    </button>
                </div>
            </div>

            <ul className="mt-2 space-y-2">
                {skewed.map((machine) => {
                    const host = machineDisplayHost(machine)
                    const version = machine.metadata?.happyCliVersion
                    const newerOnDisk = cliBinaryUpdatedOnDisk(machine.metadata)
                    const busy = busyId === machine.id
                    return (
                        <li
                            key={machine.id}
                            className="rounded border border-amber-400/60 bg-amber-100/40 p-2 dark:bg-amber-900/40"
                            data-testid={`runner-version-skew-banner-${machine.id}`}
                        >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="min-w-0 text-xs text-amber-950 dark:text-amber-50">
                                    <span className="font-medium">{host}</span>
                                    {version ? ` · CLI ${version}` : null}
                                    <span className="ml-1 text-amber-800 dark:text-amber-200">
                                        {newerOnDisk
                                            ? t('runner.skew.banner.binaryUpdatedHint')
                                            : t('runner.skew.banner.upgradeCliFirst')}
                                    </span>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <button
                                        type="button"
                                        data-testid={`runner-version-skew-upgrade-${machine.id}`}
                                        disabled={busy}
                                        onClick={() => void onUpgrade(machine)}
                                        className="rounded bg-amber-900 px-2 py-1 text-xs font-medium text-amber-50 disabled:opacity-50 dark:bg-amber-100 dark:text-amber-950"
                                    >
                                        {busy ? t('runner.skew.banner.upgrading') : t('runner.skew.banner.upgrade')}
                                    </button>
                                    <button
                                        type="button"
                                        data-testid={`runner-version-skew-restart-${machine.id}`}
                                        disabled={!newerOnDisk || busy}
                                        title={newerOnDisk ? undefined : t('runner.skew.banner.restartNeedsNewerBinary')}
                                        onClick={() => void onRestart(machine)}
                                        className="rounded border border-amber-700/50 px-2 py-1 text-xs font-medium text-amber-950 disabled:opacity-50 dark:border-amber-200/40 dark:text-amber-50"
                                    >
                                        {t('runner.skew.banner.restart')}
                                    </button>
                                </div>
                            </div>
                        </li>
                    )
                })}
            </ul>

            {actionError ? (
                <p className="mt-2 text-xs text-red-700 dark:text-red-300" data-testid="runner-version-skew-action-error">
                    {actionError}
                </p>
            ) : null}

            <p className="mt-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                {t('runner.skew.banner.handoffHint')}
            </p>
        </div>
    )
}
