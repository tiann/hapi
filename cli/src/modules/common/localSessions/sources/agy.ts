import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { agyToTranscript, agyToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { AgyLocalSessionSummary, AgyLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { listLocalAgySessionSummaries, listLocalAgySessionsWithMessagesByIds } from '../../agySessions'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'

function toItem(session: AgyLocalSessionSummary | AgyLocalSessionWithMessages): LocalSessionSourceListItem {
    return 'messages' in session
        ? agyToTranscript(session as AgyLocalSessionWithMessages)
        : agyToTranscriptSummary(session as AgyLocalSessionSummary)
}

export const agyLocalSessionSource: CliLocalSessionSource = {
    flavor: 'agy',
    list: async ({ sessionIds }) => {
        const sessions = sessionIds
            ? await listLocalAgySessionsWithMessagesByIds(new Set(sessionIds))
            : await listLocalAgySessionSummaries()
        return sessions.map((session) => toItem(session)) as Array<LocalTranscriptSummary | LocalTranscript>
    }
}
