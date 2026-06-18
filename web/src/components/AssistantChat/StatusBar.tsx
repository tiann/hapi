import {
    getCodexCollaborationModeLabel,
    getPermissionModeLabel,
    getPermissionModeTone,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol'
import type { PermissionModeTone } from '@hapi/protocol'
import { useMemo } from 'react'
import type { AgentState, CodexCollaborationMode, PermissionMode } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import type { ThreadGoal } from '@/types/api'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { isFastServiceTier } from './codexFastMode'
import { useTranslation } from '@/lib/use-translation'

// Vibing messages for thinking state
const VIBING_MESSAGES = [
    "Accomplishing", "Actioning", "Actualizing", "Baking", "Booping", "Brewing",
    "Calculating", "Cerebrating", "Channelling", "Churning", "Clauding", "Coalescing",
    "Cogitating", "Computing", "Combobulating", "Concocting", "Conjuring", "Considering",
    "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Deciphering",
    "Deliberating", "Determining", "Discombobulating", "Divining", "Doing", "Effecting",
    "Elucidating", "Enchanting", "Envisioning", "Finagling", "Flibbertigibbeting",
    "Forging", "Forming", "Frolicking", "Generating", "Germinating", "Hatching",
    "Herding", "Honking", "Ideating", "Imagining", "Incubating", "Inferring",
    "Manifesting", "Marinating", "Meandering", "Moseying", "Mulling", "Mustering",
    "Musing", "Noodling", "Percolating", "Perusing", "Philosophising", "Pontificating",
    "Pondering", "Processing", "Puttering", "Puzzling", "Reticulating", "Ruminating",
    "Scheming", "Schlepping", "Shimmying", "Simmering", "Smooshing", "Spelunking",
    "Spinning", "Stewing", "Sussing", "Synthesizing", "Thinking", "Tinkering",
    "Transmuting", "Unfurling", "Unravelling", "Vibing", "Wandering", "Whirring",
    "Wibbling", "Wizarding", "Working", "Wrangling"
]

const PERMISSION_TONE_CLASSES: Record<PermissionModeTone, string> = {
    neutral: 'text-[var(--app-hint)]',
    info: 'text-blue-500',
    warning: 'text-amber-500',
    danger: 'text-red-500'
}

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined,
    voiceStatus: ConversationStatus | undefined,
    backgroundTaskCount: number,
    t: (key: string) => string
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    // Voice connecting takes priority
    if (voiceStatus === 'connecting') {
        return {
            text: t('voice.connecting'),
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (!active) {
        return {
            text: t('misc.offline'),
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: t('misc.permissionRequired'),
            color: 'text-[#FF9500]',
            dotColor: 'bg-[#FF9500]',
            isPulsing: true
        }
    }

    if (thinking) {
        const vibingMessage = VIBING_MESSAGES[Math.floor(Math.random() * VIBING_MESSAGES.length)].toLowerCase() + '…'
        return {
            text: vibingMessage,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    if (backgroundTaskCount > 0) {
        return {
            text: `${backgroundTaskCount} background task${backgroundTaskCount > 1 ? 's' : ''} running`,
            color: 'text-[#007AFF]',
            dotColor: 'bg-[#007AFF]',
            isPulsing: true
        }
    }

    return {
        text: t('misc.online'),
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

function getContextWarning(contextSize: number, maxContextSize: number, t: (key: string, params?: Record<string, string | number>) => string): { text: string; color: string } | null {
    const percentageUsed = (contextSize / maxContextSize) * 100
    const percentageRemaining = Math.max(0, 100 - percentageUsed)

    const percent = Math.round(percentageRemaining)
    if (percentageRemaining <= 5) {
        return { text: t('misc.percentLeft', { percent }), color: 'text-red-500' }
    } else if (percentageRemaining <= 10) {
        return { text: t('misc.percentLeft', { percent }), color: 'text-amber-500' }
    } else {
        return { text: t('misc.percentLeft', { percent }), color: 'text-[var(--app-hint)]' }
    }
}

function formatTokenCount(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

function formatCodexReasoningLabel(effort?: string | null): string {
    const normalized = effort?.trim().toLowerCase()
    if (!normalized || normalized === 'default') return 'reasoning default'
    return `reasoning ${normalized}`
}

function isCodexFastMode(model?: string | null, effort?: string | null): boolean {
    const normalizedEffort = effort?.trim().toLowerCase()
    if (normalizedEffort === 'none' || normalizedEffort === 'minimal' || normalizedEffort === 'low') {
        return true
    }

    const normalizedModel = model?.trim().toLowerCase() ?? ''
    return normalizedModel.includes('mini') || normalizedModel.includes('fast')
}

/** Cursor native ACP does not emit usage_update; hide the bar to avoid empty/misleading UI. */
export function shouldShowComposerStatusBar(agentFlavor: string | null | undefined): boolean {
    return agentFlavor !== 'cursor'
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    backgroundTaskCount?: number
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    model?: string | null
    modelReasoningEffort?: string | null
    serviceTier?: string | null
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    threadGoal?: ThreadGoal | null
    agentFlavor?: string | null
    voiceStatus?: ConversationStatus
}) {
    const { t } = useTranslation()
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount ?? 0, t),
        [props.active, props.thinking, props.agentState, props.voiceStatus, props.backgroundTaskCount, t]
    )

    const contextWarning = useMemo(
        () => {
            if (props.contextSize === undefined) return null
            const maxContextSize = props.contextWindow ?? getContextBudgetTokens(props.model, props.agentFlavor)
            if (!maxContextSize) return null
            return getContextWarning(props.contextSize, maxContextSize, t)
        },
        [props.contextSize, props.contextWindow, props.model, props.agentFlavor, t]
    )
    const contextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(props.model, props.agentFlavor)
        if (!maxContextSize) return `ctx ${formatTokenCount(props.contextSize)}`
        const percentageUsed = Math.min(100, Math.round((props.contextSize / maxContextSize) * 100))
        return `ctx ${formatTokenCount(props.contextSize)}/${formatTokenCount(maxContextSize)} (${percentageUsed}%)`
    }, [props.contextSize, props.contextWindow, props.model, props.agentFlavor])
    const compactContextUsageLabel = useMemo(() => {
        if (props.contextSize === undefined) return null
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(props.model, props.agentFlavor)
        if (!maxContextSize) return `ctx ${formatTokenCount(props.contextSize)}`
        const percentageLeft = Math.max(0, Math.round(100 - (props.contextSize / maxContextSize) * 100))
        return `ctx ${formatTokenCount(maxContextSize).toUpperCase()}, ${percentageLeft}% left`
    }, [props.contextSize, props.contextWindow, props.model, props.agentFlavor])
    const cacheHitLabel = useMemo(() => {
        if (!props.contextCacheRead || props.contextCacheRead <= 0) return null
        return `cache ${formatTokenCount(props.contextCacheRead)}`
    }, [props.contextCacheRead])

    const permissionMode = props.permissionMode
    const displayPermissionMode = permissionMode
        && permissionMode !== 'default'
        && isPermissionModeAllowedForFlavor(permissionMode, props.agentFlavor)
        ? permissionMode
        : null

    const permissionModeLabel = displayPermissionMode ? getPermissionModeLabel(displayPermissionMode) : null
    const permissionModeTone = displayPermissionMode ? getPermissionModeTone(displayPermissionMode) : null
    const permissionModeColor = permissionModeTone ? PERMISSION_TONE_CLASSES[permissionModeTone] : 'text-[var(--app-hint)]'
    const displayCollaborationMode = props.agentFlavor === 'codex' && props.collaborationMode === 'plan'
        ? props.collaborationMode
        : null
    const collaborationModeLabel = displayCollaborationMode
        ? getCodexCollaborationModeLabel(displayCollaborationMode)
        : null
    const codexReasoningLabel = (props.agentFlavor === 'codex' || props.agentFlavor === 'opencode')
        ? formatCodexReasoningLabel(props.modelReasoningEffort)
        : null
    // Prefer the explicit service tier (the real Fast-mode toggle) when set;
    // fall back to the effort/model heuristic only when the tier is unknown.
    const codexFastMode = props.agentFlavor === 'codex'
        ? (props.serviceTier != null
            ? isFastServiceTier(props.serviceTier)
            : isCodexFastMode(props.model, props.modelReasoningEffort))
        : false
    const goalLabel = props.agentFlavor === 'codex' && props.threadGoal
        ? props.threadGoal.status === 'active'
            ? 'goal'
            : `goal ${props.threadGoal.status === 'budgetLimited' ? 'limited' : props.threadGoal.status}`
        : null

    return (
        <div className="flex min-w-0 items-center justify-between gap-2 px-2 pb-1">
            <div className="flex min-w-0 items-baseline gap-2 sm:gap-3">
                <div className="flex shrink-0 items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`whitespace-nowrap text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
                {contextUsageLabel ? (
                    <span className={`min-w-0 whitespace-nowrap text-[10px] ${contextWarning?.color ?? 'text-[var(--app-hint)]'}`}>
                        <span className="sm:hidden">
                            {compactContextUsageLabel}
                        </span>
                        <span className="hidden sm:inline">
                            {contextUsageLabel}{contextWarning ? ` · ${contextWarning.text}` : ''}
                        </span>
                    </span>
                ) : null}
                {cacheHitLabel ? (
                    <span className="hidden whitespace-nowrap text-[10px] text-[var(--app-hint)] sm:inline">
                        {cacheHitLabel}
                    </span>
                ) : null}
            </div>

            <div className="flex min-w-0 shrink-0 items-center gap-2">
                {codexReasoningLabel ? (
                    <span className="whitespace-nowrap text-xs text-[var(--app-hint)]">
                        {codexReasoningLabel}
                    </span>
                ) : null}
                {codexFastMode ? (
                    <span className="whitespace-nowrap text-xs text-[#34C759]">
                        fast
                    </span>
                ) : null}
                {goalLabel ? (
                    <span className="whitespace-nowrap text-xs text-[var(--app-link)]">
                        {goalLabel}
                    </span>
                ) : null}
                {collaborationModeLabel ? (
                    <span className="whitespace-nowrap text-xs text-blue-500">
                        {collaborationModeLabel}
                    </span>
                ) : null}
                {displayPermissionMode ? (
                    <span className={`whitespace-nowrap text-xs ${permissionModeColor}`}>
                        {permissionModeLabel}
                    </span>
                ) : null}
            </div>
        </div>
    )
}
