import type { SessionHeaderMetadataPreferences } from '@/hooks/useSessionHeaderMetadata'
import { formatReasoningLabel, getReasoningEffortForFlavor } from '@/lib/codexStatusLabels'

export type ShareTurnMetadataKey = Exclude<keyof SessionHeaderMetadataPreferences, 'showLabels' | 'agentIcon'>

export type ShareTurnMetadataItem = {
    key: ShareTurnMetadataKey
    text: string
    flavor?: string | null
    showIcon?: boolean
    showText?: boolean
}

export function getShareTurnReasoningLabel(
    agentFlavor: string | null | undefined,
    modelReasoningEffort: string | null | undefined,
    effort: string | null | undefined,
    showLabels: boolean
): string | null {
    const reasoningEffort = getReasoningEffortForFlavor(agentFlavor, modelReasoningEffort, effort)
    return reasoningEffort ? formatReasoningLabel(reasoningEffort, showLabels) : null
}

const SESSION_HEADER_METADATA_ORDER: ReadonlyArray<ShareTurnMetadataKey> = [
    'agent',
    'machine',
    'lastActive',
    'model',
    'reasoning',
    'fastMode',
    'createdAt',
    'updatedAt',
    'worktree',
]

export function selectShareTurnMetadata(
    preferences: SessionHeaderMetadataPreferences,
    available: Partial<Record<ShareTurnMetadataKey, Omit<ShareTurnMetadataItem, 'key'>>>
): ShareTurnMetadataItem[] {
    return SESSION_HEADER_METADATA_ORDER.flatMap((key) => {
        const item = available[key]
        const enabled = key === 'agent'
            ? preferences.agent || preferences.agentIcon
            : preferences[key]
        if (!enabled || !item?.text) return []

        return [{
            key,
            ...item,
            ...(key === 'agent' ? {
                showIcon: preferences.agentIcon,
                showText: preferences.agent,
            } : {}),
        }]
    })
}
