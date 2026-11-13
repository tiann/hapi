import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { opencodeToTranscript, opencodeToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { OpencodeLocalSessionSummary, OpencodeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { listLocalOpencodeSessionSummaries, listLocalOpencodeSessionsWithMessagesByIds } from '../../opencodeSessions'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'

function toItem(session: OpencodeLocalSessionSummary | OpencodeLocalSessionWithMessages): LocalSessionSourceListItem {
    return 'messages' in session
        ? opencodeToTranscript(session as OpencodeLocalSessionWithMessages)
        : opencodeToTranscriptSummary(session as OpencodeLocalSessionSummary)
}

export const opencodeLocalSessionSource: CliLocalSessionSource = {
    flavor: 'opencode',
    list: async ({ sessionIds }) => {
        const sessions = sessionIds
            ? await listLocalOpencodeSessionsWithMessagesByIds(new Set(sessionIds))
            : await listLocalOpencodeSessionSummaries()
        return sessions.map((session) => toItem(session)) as Array<LocalTranscriptSummary | LocalTranscript>
    }
}