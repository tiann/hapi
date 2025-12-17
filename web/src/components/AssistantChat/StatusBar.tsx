import { useMemo } from 'react'
import type { AgentState, PermissionMode } from '@/types/api'

const PERMISSION_MODE_LABELS: Record<string, string> = {
    default: 'Default',
    acceptEdits: 'Accept Edits',
    plan: 'Plan Mode',
    bypassPermissions: 'Bypass All'
}

// Max context size for percentage calculation
const MAX_CONTEXT_SIZE = 190000

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

function getConnectionStatus(
    active: boolean,
    thinking: boolean,
    agentState: AgentState | null | undefined
): { text: string; color: string; dotColor: string; isPulsing: boolean } {
    const hasPermissions = agentState?.requests && Object.keys(agentState.requests).length > 0

    if (!active) {
        return {
            text: 'offline',
            color: 'text-[#999]',
            dotColor: 'bg-[#999]',
            isPulsing: false
        }
    }

    if (hasPermissions) {
        return {
            text: 'permission required',
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

    return {
        text: 'online',
        color: 'text-[#34C759]',
        dotColor: 'bg-[#34C759]',
        isPulsing: false
    }
}

function getContextWarning(contextSize: number): { text: string; color: string } | null {
    const percentageUsed = (contextSize / MAX_CONTEXT_SIZE) * 100
    const percentageRemaining = 100 - percentageUsed

    if (percentageRemaining <= 5) {
        return { text: `${Math.round(percentageRemaining)}% left`, color: 'text-red-500' }
    } else if (percentageRemaining <= 10) {
        return { text: `${Math.round(percentageRemaining)}% left`, color: 'text-amber-500' }
    } else {
        return { text: `${Math.round(percentageRemaining)}% left`, color: 'text-[var(--app-hint)]' }
    }
}

export function StatusBar(props: {
    active: boolean
    thinking: boolean
    agentState: AgentState | null | undefined
    contextSize?: number
    permissionMode?: PermissionMode
}) {
    const connectionStatus = useMemo(
        () => getConnectionStatus(props.active, props.thinking, props.agentState),
        [props.active, props.thinking, props.agentState]
    )

    const contextWarning = useMemo(
        () => props.contextSize !== undefined ? getContextWarning(props.contextSize) : null,
        [props.contextSize]
    )

    const permissionMode = props.permissionMode

    return (
        <div className="flex items-center justify-between px-2 pb-1">
            <div className="flex items-baseline gap-3">
                <div className="flex items-center gap-1.5">
                    <span
                        className={`h-2 w-2 rounded-full ${connectionStatus.dotColor} ${connectionStatus.isPulsing ? 'animate-pulse' : ''}`}
                    />
                    <span className={`text-xs ${connectionStatus.color}`}>
                        {connectionStatus.text}
                    </span>
                </div>
                {contextWarning ? (
                    <span className={`text-[10px] ${contextWarning.color}`}>
                        {contextWarning.text}
                    </span>
                ) : null}
            </div>

            {(permissionMode && permissionMode !== 'default') ? (
                <span className={`text-xs ${
                    permissionMode === 'acceptEdits' ? 'text-amber-500' :
                    permissionMode === 'bypassPermissions' ? 'text-red-500' :
                    permissionMode === 'plan' ? 'text-blue-500' :
                    'text-[var(--app-hint)]'
                }`}>
                    {PERMISSION_MODE_LABELS[permissionMode]}
                </span>
            ) : null}
        </div>
    )
}

