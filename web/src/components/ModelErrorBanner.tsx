import { useState } from 'react'
import { useTranslation } from '@/lib/use-translation'

// Minimal shape that both Metadata and SessionSummaryMetadata satisfy
export type ModelErrorHolder = {
    lastModelError?: {
        eventId: string
        kind: string
        transient: boolean
        rawSnippet: string
        atTs: number
        priorAssistantClaimsDone: boolean
        bridgedForEventId?: string
        retriedAndFailed?: boolean
        supersededByUserTurn?: boolean
        bridgeable?: boolean
        acknowledgedAt?: number
    }
    [key: string]: unknown
}

export type ModelErrorUiState = 'unrecovered' | 'recovered' | 'bridge_failed'

export function getModelErrorUiState(metadata: ModelErrorHolder | null | undefined): ModelErrorUiState | null {
    const err = metadata?.lastModelError
    if (!err || err.acknowledgedAt) {
        return null
    }
    if (err.retriedAndFailed) {
        return 'bridge_failed'
    }
    if (err.bridgedForEventId === err.eventId) {
        return 'recovered'
    }
    return 'unrecovered'
}

export function canShowModelErrorBridge(metadata: ModelErrorHolder | null | undefined): boolean {
    return getModelErrorUiState(metadata) === 'unrecovered'
        && Boolean(metadata?.lastModelError?.transient)
        && !metadata?.lastModelError?.supersededByUserTurn
        && metadata?.lastModelError?.bridgeable !== false
}

/**
 * True after the CLI accepted a Bridge enqueue for `pendingEventId` and before
 * metadata records recovered / failed / superseded / acknowledged / a new error.
 */
export function isBridgeSettling(
    metadata: ModelErrorHolder | null | undefined,
    pendingEventId: string | null
): boolean {
    const err = metadata?.lastModelError
    if (!pendingEventId || !err || err.eventId !== pendingEventId) {
        return false
    }
    if (err.acknowledgedAt || err.retriedAndFailed || err.supersededByUserTurn) {
        return false
    }
    if (err.bridgedForEventId === pendingEventId) {
        return false
    }
    return true
}

export function shouldKeepPendingBridge(
    sessionActive: boolean,
    settling: boolean,
    aborted = false
): boolean {
    return sessionActive && settling && !aborted
}

export function visibleBridgeFailureReason(
    failure: { eventId: string; reason: string } | null,
    currentEventId: string | undefined
): string | null {
    if (!failure || !currentEventId || failure.eventId !== currentEventId) {
        return null
    }
    return failure.reason
}

/** Any unacknowledged model-error surface (error, recovered, or bridge failed). */
export function hasActiveModelError(metadata: ModelErrorHolder | null | undefined): boolean {
    return getModelErrorUiState(metadata) !== null
}

/** Amber pulse: unrecovered or bridge-failed. Not recovered. */
export function hasUrgentModelError(metadata: ModelErrorHolder | null | undefined): boolean {
    const state = getModelErrorUiState(metadata)
    return state === 'unrecovered' || state === 'bridge_failed'
}

export function hasRecoveredModelError(metadata: ModelErrorHolder | null | undefined): boolean {
    return getModelErrorUiState(metadata) === 'recovered'
}

export function ModelErrorBanner({
    metadata,
    onDismiss,
    onBridge,
    isBridging = false,
    bridgeErrorReason = null
}: {
    metadata: ModelErrorHolder | null | undefined
    onDismiss: () => void
    onBridge?: () => void
    isBridging?: boolean
    bridgeErrorReason?: string | null
}) {
    const { t } = useTranslation()
    const [showRaw, setShowRaw] = useState(false)

    const err = metadata?.lastModelError
    const uiState = getModelErrorUiState(metadata)
    if (!err || !uiState) {
        return null
    }

    const transientLabel = err.transient
        ? t('session.modelError.banner.subtitle.transient')
        : t('session.modelError.banner.subtitle.nonTransient')

    const isRecovered = uiState === 'recovered'
    const isBridgeFailed = uiState === 'bridge_failed'

    const title = isRecovered
        ? t('session.modelError.banner.recoveredTitle', { kind: err.kind })
        : isBridgeFailed
            ? t('session.modelError.banner.bridgeFailedTitle', { kind: err.kind })
            : t('session.modelError.banner.title', { kind: err.kind })

    const bodyText = isRecovered
        ? t('session.modelError.banner.recoveredBody')
        : isBridgeFailed
            ? t('session.modelError.banner.bridgeFailedBody')
            : err.priorAssistantClaimsDone
                ? t('session.modelError.banner.claimedDone')
                : t('session.modelError.banner.midExecution')

    const showBridge = canShowModelErrorBridge(metadata) && onBridge

    const shellClass = isRecovered
        ? 'border-emerald-500/40 bg-emerald-500/10'
        : 'border-amber-500/40 bg-amber-500/10'

    const titleClass = isRecovered
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-amber-600 dark:text-amber-400'

    const icon = isRecovered ? '\u2713' : '\u26A0'

    return (
        <div className="px-3 pt-3" data-testid="model-error-banner" data-state={uiState}>
            <div
                role="alert"
                aria-live="assertive"
                className={`mx-auto flex w-full max-w-content flex-col gap-2 rounded-md border p-3 text-sm text-[var(--app-text)] ${shellClass}`}
            >
                <div className="flex items-start gap-2">
                    <span aria-hidden="true" className={`mt-0.5 shrink-0 ${titleClass}`}>
                        {icon}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className={`font-semibold ${titleClass}`}>
                            {title}{' '}
                            {!isRecovered ? (
                                <span className="text-xs font-normal opacity-70">
                                    ({transientLabel})
                                </span>
                            ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                            {bodyText}
                        </div>
                        {showRaw && (
                            <pre className="mt-2 max-h-24 overflow-auto rounded bg-black/10 p-2 text-xs font-mono whitespace-pre-wrap break-all dark:bg-white/5">
                                {err.rawSnippet}
                            </pre>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2 pl-6">
                    {showBridge ? (
                        <button
                            type="button"
                            onClick={onBridge}
                            disabled={isBridging}
                            className="rounded px-2 py-0.5 text-xs font-medium border border-amber-500/50 text-amber-700 hover:bg-amber-500/10 disabled:opacity-50 dark:text-amber-300 transition-colors"
                        >
                            {isBridging
                                ? t('session.modelError.banner.bridging')
                                : t('session.modelError.banner.bridgeRetry')}
                        </button>
                    ) : null}
                    {bridgeErrorReason ? (
                        <span className="text-xs text-amber-700 dark:text-amber-300">
                            {t('session.modelError.banner.bridgeFailed')}
                        </span>
                    ) : null}
                    <button
                        type="button"
                        onClick={onDismiss}
                        className="rounded px-2 py-0.5 text-xs font-medium border border-[var(--app-border)] hover:bg-[var(--app-subtle-bg)] transition-colors"
                    >
                        {t('session.modelError.banner.dismiss')}
                    </button>
                    <button
                        type="button"
                        onClick={() => setShowRaw((v) => !v)}
                        className="rounded px-2 py-0.5 text-xs font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] transition-colors"
                    >
                        {t('session.modelError.banner.viewRaw')}
                    </button>
                </div>
            </div>
        </div>
    )
}
