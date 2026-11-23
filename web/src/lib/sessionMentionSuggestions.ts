import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { SessionSummary } from '@/types/api'
import { buildSessionReferenceText, matchSessionsForMention } from './sessionReference'
import { getSessionTitle } from './sessionTitle'

/** Build independent shortlists so active sessions cannot crowd out the inactive group. */
export function buildSessionMentionSuggestions(args: {
    sessions: readonly SessionSummary[]
    query: string
    excludeId?: string
    resolveMachineLabel: (machineId: string | null) => string
    inactiveCollapsed: boolean
    inactiveLabel: string
    toggleInactive: () => void
}): Suggestion[] {
    const matches = matchSessionsForMention(args.sessions, args.query, {
        excludeId: args.excludeId,
        resolveMachineLabel: args.resolveMachineLabel,
        limit: Infinity,
    })
    const active = matches.filter(session => session.active).slice(0, 20)
    const inactive = matches.filter(session => !session.active).slice(0, 20)
    const toSuggestion = (session: SessionSummary): Suggestion => {
        const title = getSessionTitle(session)
        const idPrefix = session.id.slice(0, 8)
        return {
            key: `session:${session.id}`,
            text: buildSessionReferenceText(title, session.id),
            label: `@${title || idPrefix}`,
            description: session.active ? `Session · ${idPrefix} · active` : `Session · ${idPrefix}`,
            sessionMention: { id: session.id, title: title || idPrefix },
        }
    }
    const result = active.map(toSuggestion)
    if (inactive.length) {
        result.push({
            key: 'session:inactive-toggle',
            text: '',
            label: args.inactiveLabel,
            action: { expanded: !args.inactiveCollapsed, onSelect: args.toggleInactive },
        })
        if (!args.inactiveCollapsed) result.push(...inactive.map(toSuggestion))
    }
    return result
}
