import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { cliBinaryUpdatedOnDisk, MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import {
    DEFAULT_FLEET_UPGRADE_POLICY,
    machineTrailsUpgradeOffer,
    type FleetUpgradePolicy,
    type HubUpgradeOffer,
} from '@hapi/protocol/upgradeChannel'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'
import { useUpgradeInfo } from '@/hooks/queries/useUpgradeInfo'
import { useTranslation } from '@/lib/use-translation'
import { useAppContext } from '@/lib/app-context'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { usePlatform } from '@/hooks/usePlatform'
import { useToast } from '@/lib/toast-context'
import { queryKeys } from '@/lib/query-keys'
import {
    clearRunnerSkewTempDismiss,
    getRunnerSkewDismissUntil,
    isRunnerSkewMinimized,
    isRunnerSkewTempDismissed,
    runnerSkewBannerScope,
    setRunnerSkewMinimized,
    tempDismissRunnerSkew,
} from '@/lib/runnerSkewBannerState'
import { getTokenNamespace } from '@/lib/tokenNamespace'

type RunnerSelfUpgradeStatus = 'started' | 'already-current' | 'unsupported' | 'failed'

function upgradeResponseStatus(response: unknown): RunnerSelfUpgradeStatus | null {
    if (!response || typeof response !== 'object') {
        return null
    }
    const status = (response as { status?: unknown }).status
    if (
        status === 'started'
        || status === 'already-current'
        || status === 'unsupported'
        || status === 'failed'
    ) {
        return status
    }
    return null
}

export function machineDisplayHost(machine: Machine): string {
    return machine.metadata?.displayName
        ?? machine.metadata?.host
        ?? machine.id
}

/** True when the hub can auto-RPC self-upgrade for this machine. */
export function machineCanAutoUpgrade(machine: Machine): boolean {
    if (machine.metadata?.versionHandoffDisabled === true) {
        return false
    }
    return (machine.metadata?.capabilities ?? []).includes(MACHINE_CAPABILITIES.RunnerSelfUpgrade)
}

export function listSkewedMachines(machines: Machine[], offer: HubUpgradeOffer | null): Machine[] {
    if (!offer) {
        return []
    }
    // Include versionHandoffDisabled (soup/rebuild-only) hosts when they trail on
    // version/capability or have a newer binary on disk so Restart stays visible.
    // Ignore generation drift for those hosts — they never write a marker.
    return machines.filter((machine) => {
        if (!machine.active) {
            return false
        }
        const handoffDisabled = machine.metadata?.versionHandoffDisabled === true
        if (machineTrailsUpgradeOffer(
            offer,
            machine.metadata?.happyCliVersion,
            machine.metadata?.capabilities,
            machine.metadata?.cliArtifactGeneration,
            { ignoreGenerationDrift: handoffDisabled },
        )) {
            return true
        }
        return handoffDisabled && cliBinaryUpdatedOnDisk(machine.metadata)
    })
}

/**
 * Machines the banner should list for the current fleet policy.
 * Under `auto`, still list every skewed host: the hub only toasts
 * `upgrade_failed` and does not expose per-machine in-flight/failed state, so
 * hiding self-upgrade-capable hosts would leave permanent failures with no
 * recovery UI. `silent` still suppresses the banner entirely.
 */
export function listBannerSkewMachines(
    machines: Machine[],
    offer: HubUpgradeOffer | null,
    policy: FleetUpgradePolicy,
): Machine[] {
    if (policy === 'silent') {
        return []
    }
    return listSkewedMachines(machines, offer)
}

/**
 * Confirm a previously auto-skewed host has actually caught up before toasting.
 * Going offline (or disappearing) is not success — keep those IDs pending.
 */
export function collectConfirmedAutoUpgradeToasts(options: {
    previousAutoSkewIds: ReadonlySet<string>
    machines: Machine[]
    offer: HubUpgradeOffer
}): { toastHosts: string[]; nextAutoSkewIds: Set<string> } {
    const nextAutoSkewIds = new Set(
        listSkewedMachines(options.machines, options.offer)
            .filter((machine) => machineCanAutoUpgrade(machine))
            .map((machine) => machine.id),
    )
    const toastHosts: string[] = []
    for (const id of options.previousAutoSkewIds) {
        if (nextAutoSkewIds.has(id)) {
            continue
        }
        const machine = options.machines.find((entry) => entry.id === id)
        if (!machine) {
            // /api/machines is online-only — absence is a disconnect, not success.
            nextAutoSkewIds.add(id)
            continue
        }
        if (!machine.active) {
            // Temporary disconnect — do not claim upgrade success.
            nextAutoSkewIds.add(id)
            continue
        }
        if (listSkewedMachines([machine], options.offer).length > 0) {
            continue
        }
        if (!machineCanAutoUpgrade(machine)) {
            // Lost self-upgrade capability without catching up — not success.
            continue
        }
        toastHosts.push(machineDisplayHost(machine))
    }
    return { toastHosts, nextAutoSkewIds }
}

/**
 * Compact, minimizable skew banner (#1084).
 * Primary action: fleet Upgrade (npm or hub-artifact). Restart is escape hatch.
 */
export function RunnerVersionSkewBanner({
    topClassName,
    stacked = false,
}: {
    topClassName?: string
    /** When true, parent owns fixed positioning (share a vertical stack). */
    stacked?: boolean
} = {}) {
    const { api, token, baseUrl } = useAppContext()
    const queryClient = useQueryClient()
    const { machines } = useMachines(api, true)
    const { info } = useUpgradeInfo(api, true)
    const { t } = useTranslation()
    const { addToast } = useToast()
    const isOnline = useOnlineStatus()
    const { haptic } = usePlatform()
    const policy = info?.policy ?? DEFAULT_FLEET_UPGRADE_POLICY
    const offer = info?.offer ?? null
    const skewed = listBannerSkewMachines(machines, offer, policy)
    const bannerScope = runnerSkewBannerScope(baseUrl, getTokenNamespace(token))
    const [minimized, setMinimized] = useState(() => isRunnerSkewMinimized(bannerScope))
    const [dismissed, setDismissed] = useState(() => isRunnerSkewTempDismissed(bannerScope))
    const [busyId, setBusyId] = useState<string | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)
    const [actionInfo, setActionInfo] = useState<string | null>(null)
    const autoSkewPrimedRef = useRef(false)
    const prevAutoSkewIdsRef = useRef<Set<string>>(new Set())

    // Under auto: toast only when a previously skewed auto-eligible host is
    // still online and confirmed caught up (not merely offline / missing).
    useEffect(() => {
        if (policy !== 'auto' || !offer) {
            autoSkewPrimedRef.current = false
            prevAutoSkewIdsRef.current = new Set()
            return
        }
        if (!autoSkewPrimedRef.current) {
            autoSkewPrimedRef.current = true
            prevAutoSkewIdsRef.current = new Set(
                listSkewedMachines(machines, offer)
                    .filter((machine) => machineCanAutoUpgrade(machine))
                    .map((machine) => machine.id),
            )
            return
        }
        const { toastHosts, nextAutoSkewIds } = collectConfirmedAutoUpgradeToasts({
            previousAutoSkewIds: prevAutoSkewIdsRef.current,
            machines,
            offer,
        })
        for (const host of toastHosts) {
            addToast({
                title: t('toast.runnerUpgrade.success.title'),
                body: t('toast.runnerUpgrade.success.body', { host }),
                sessionId: '',
                url: '/',
            })
        }
        prevAutoSkewIdsRef.current = nextAutoSkewIds
    }, [policy, offer, machines, addToast, t])

    useEffect(() => {
        setMinimized(isRunnerSkewMinimized(bannerScope))
        setDismissed(isRunnerSkewTempDismissed(bannerScope))
    }, [bannerScope])

    useEffect(() => {
        if (!dismissed) {
            return
        }
        const remaining = Math.max(0, getRunnerSkewDismissUntil(bannerScope) - Date.now())
        if (remaining === 0) {
            clearRunnerSkewTempDismiss(bannerScope)
            setDismissed(false)
            return
        }
        const timer = window.setTimeout(() => {
            clearRunnerSkewTempDismiss(bannerScope)
            setDismissed(false)
        }, remaining)
        return () => window.clearTimeout(timer)
    }, [dismissed, bannerScope])

    const onMinimize = useCallback(() => {
        haptic.impact('light')
        setMinimized(true)
        setRunnerSkewMinimized(bannerScope, true)
    }, [haptic, bannerScope])

    const onExpand = useCallback(() => {
        haptic.impact('light')
        setMinimized(false)
        setRunnerSkewMinimized(bannerScope, false)
    }, [haptic, bannerScope])

    const onTempDismiss = useCallback(() => {
        haptic.impact('light')
        setDismissed(true)
        tempDismissRunnerSkew(bannerScope)
    }, [haptic, bannerScope])

    const refreshFleetQueries = useCallback(async () => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.machines }),
            queryClient.invalidateQueries({ queryKey: queryKeys.upgradeInfo }),
        ])
    }, [queryClient])

    const onUpgrade = useCallback(async (machine: Machine) => {
        if (!api) {
            return
        }
        haptic.impact('medium')
        setActionError(null)
        setActionInfo(null)
        setBusyId(machine.id)
        try {
            const result = await api.upgradeMachineRunner(machine.id)
            const status = upgradeResponseStatus(result.response)
            // already-current is a successful RPC that installs nothing — surface it
            // so "Upgrading…" → idle does not look like a silent failure (Teemo #1108).
            if (status === 'already-current') {
                setActionInfo(result.message || t('runner.skew.alreadyCurrent'))
            } else if (status === 'started') {
                setActionInfo(result.message || t('runner.skew.upgradeStarted'))
            } else if (result.message) {
                setActionInfo(result.message)
            }
            await refreshFleetQueries()
        } catch (error) {
            setActionError(error instanceof Error ? error.message : t('runner.skew.upgradeFailed'))
        } finally {
            setBusyId(null)
        }
    }, [api, haptic, refreshFleetQueries, t])

    const onRestart = useCallback(async (machine: Machine) => {
        if (!api) {
            return
        }
        haptic.impact('medium')
        setActionError(null)
        setActionInfo(null)
        setBusyId(machine.id)
        try {
            const result = await api.restartMachineRunner(machine.id)
            if (result.message) {
                setActionInfo(result.message)
            }
            await refreshFleetQueries()
        } catch (error) {
            setActionError(error instanceof Error ? error.message : t('runner.skew.restartFailed'))
        } finally {
            setBusyId(null)
        }
    }, [api, haptic, refreshFleetQueries, t])

    if (skewed.length === 0 || dismissed) {
        return null
    }

    const topClass = topClassName ?? (isOnline ? 'top-2' : 'top-10')
    const hosts = skewed.map(machineDisplayHost).join(', ')
    const positionClass = stacked
        ? 'relative w-full'
        : `fixed left-4 right-4 z-40 ${topClass}`

    if (minimized) {
        return (
            <div
                data-testid="runner-version-skew-banner"
                data-state="minimized"
                className={positionClass}
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
            className={`${positionClass} max-h-[40vh] overflow-y-auto rounded-lg border-2 border-amber-500 bg-amber-50 p-3 shadow-lg dark:bg-amber-950/90`}
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-amber-950 dark:text-amber-50">
                        {policy === 'auto'
                            ? t('runner.skew.banner.autoProblemTitle', { count: skewed.length })
                            : t('runner.skew.banner.summaryTitle', { count: skewed.length })}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-amber-900 dark:text-amber-100">
                        {policy === 'auto'
                            ? t('runner.skew.banner.autoProblemBody')
                            : t('runner.skew.banner.summaryBody')}
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
                    const handoffDisabled = machine.metadata?.versionHandoffDisabled === true
                    const supervisedRestart = machine.metadata?.supervisedRestart === true
                    const supportsSelfUpgrade = (machine.metadata?.capabilities ?? [])
                        .includes(MACHINE_CAPABILITIES.RunnerSelfUpgrade)
                    const busy = busyId === machine.id
                    // Upgrade owns package+handoff relaunch. Restart is stop-only and is
                    // only safe when an external supervisor (HAPI_RUNNER_SUPERVISED=1) will relaunch.
                    // Legacy runners without RunnerSelfUpgrade cannot receive the RPC.
                    const canUpgrade = !handoffDisabled && supportsSelfUpgrade
                    const canRestart = supervisedRestart && newerOnDisk
                    const upgradeDisabledTitle = handoffDisabled
                        ? t('runner.skew.banner.upgradeNeedsHandoff')
                        : !supportsSelfUpgrade
                            ? t('runner.skew.banner.upgradeNeedsManual')
                            : undefined
                    const restartDisabledTitle = !supervisedRestart
                        ? t('runner.skew.banner.restartNeedsSupervisor')
                        : !newerOnDisk
                            ? t('runner.skew.banner.restartNeedsNewerBinary')
                            : undefined
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
                                        {handoffDisabled
                                            ? t('runner.skew.banner.handoffDisabledHint')
                                            : !supportsSelfUpgrade
                                                ? t('runner.skew.banner.legacyRunnerHint')
                                                : newerOnDisk
                                                    ? t('runner.skew.banner.binaryUpdatedHint')
                                                    : t('runner.skew.banner.upgradeCliFirst')}
                                    </span>
                                </div>
                                <div className="flex shrink-0 gap-1">
                                    <button
                                        type="button"
                                        data-testid={`runner-version-skew-upgrade-${machine.id}`}
                                        disabled={!canUpgrade || busy}
                                        title={canUpgrade ? undefined : upgradeDisabledTitle}
                                        onClick={() => void onUpgrade(machine)}
                                        className="rounded bg-amber-900 px-2 py-1 text-xs font-medium text-amber-50 disabled:opacity-50 dark:bg-amber-100 dark:text-amber-950"
                                    >
                                        {busy && canUpgrade ? t('runner.skew.banner.upgrading') : t('runner.skew.banner.upgrade')}
                                    </button>
                                    <button
                                        type="button"
                                        data-testid={`runner-version-skew-restart-${machine.id}`}
                                        disabled={!canRestart || busy}
                                        title={canRestart ? undefined : restartDisabledTitle}
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
            {actionInfo && !actionError ? (
                <p className="mt-2 text-xs text-amber-900 dark:text-amber-100" data-testid="runner-version-skew-action-info">
                    {actionInfo}
                </p>
            ) : null}

            <p className="mt-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                {t('runner.skew.banner.handoffHint')}
            </p>
        </div>
    )
}
