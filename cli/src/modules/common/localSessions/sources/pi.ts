import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { piToTranscript, piToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { PiLocalSessionSummary, PiLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { listLocalPiSessionSummaries, listLocalPiSessionsWithMessagesByIds } from '../../piSessions'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'

function toItem(session: PiLocalSessionSummary | PiLocalSessionWithMessages): LocalSessionSourceListItem {
    return 'messages' in session
        ? piToTranscript(session as PiLocalSessionWithMessages)
        : piToTranscriptSummary(session as PiLocalSessionSummary)
}

export const piLocalSessionSource: CliLocalSessionSource = {
    flavor: 'pi',
    list: ({ sessionIds }) => {
        const sessions = sessionIds
            ? listLocalPiSessionsWithMessagesByIds(new Set(sessionIds))
            : listLocalPiSessionSummaries()
        return sessions.map((session) => toItem(session)) as Array<LocalTranscriptSummary | LocalTranscript>
    }
}