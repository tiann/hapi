import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { codexToTranscript, codexToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { CodexLocalSessionSummary, CodexLocalSessionWithMessages } from '@hapi/protocol/localTranscript'
import { listLocalCodexSessionSummaries, listLocalCodexSessionsWithMessagesByIds } from '../../codexSessions'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'

function toItem(session: CodexLocalSessionSummary | CodexLocalSessionWithMessages): LocalSessionSourceListItem {
    return 'messages' in session
        ? codexToTranscript(session as CodexLocalSessionWithMessages)
        : codexToTranscriptSummary(session as CodexLocalSessionSummary)
}

export const codexLocalSessionSource: CliLocalSessionSource = {
    flavor: 'codex',
    list: ({ sessionIds }) => {
        const sessions = sessionIds
            ? listLocalCodexSessionsWithMessagesByIds(new Set(sessionIds))
            : listLocalCodexSessionSummaries()
        return sessions.map((session) => toItem(session)) as Array<LocalTranscriptSummary | LocalTranscript>
    }
}