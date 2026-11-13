import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { claudeToTranscript, claudeToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { ClaudeLocalSessionSummary, ClaudeLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { listLocalClaudeSessionSummaries, listLocalClaudeSessionsWithMessagesByIds } from '../../claudeSessions'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'

function toItem(session: ClaudeLocalSessionSummary | ClaudeLocalSessionWithMessages): LocalSessionSourceListItem {
    return 'messages' in session
        ? claudeToTranscript(session as ClaudeLocalSessionWithMessages)
        : claudeToTranscriptSummary(session as ClaudeLocalSessionSummary)
}

export const claudeLocalSessionSource: CliLocalSessionSource = {
    flavor: 'claude',
    list: async ({ sessionIds }) => {
        const sessions = sessionIds
            ? await listLocalClaudeSessionsWithMessagesByIds(new Set(sessionIds))
            : await listLocalClaudeSessionSummaries()
        return sessions.map((session) => toItem(session)) as Array<LocalTranscriptSummary | LocalTranscript>
    }
}