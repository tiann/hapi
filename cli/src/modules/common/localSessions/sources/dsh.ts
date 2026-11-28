import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import { dshToTranscript, dshToTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { DshLocalSessionSummary, DshLocalSessionWithMessages } from '@hapi/protocol/apiTypes'
import { listDshSessionSummaries, readDshSessionTranscriptsByIds } from '@/dsh/utils/dshSessionLog'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'

function toItem(session: DshLocalSessionSummary | DshLocalSessionWithMessages): LocalSessionSourceListItem {
    return 'messages' in session
        ? dshToTranscript(session as DshLocalSessionWithMessages)
        : dshToTranscriptSummary(session as DshLocalSessionSummary)
}

export const dshLocalSessionSource: CliLocalSessionSource = {
    flavor: 'dsh',
    list: async ({ sessionIds }) => {
        // The disk reader folds durable logs straight off ~/.dsh — no dsh
        // child process is started, so scanning never touches a live agent.
        // Transcripts are read one session at a time, each size-bounded; a
        // session that cannot be imported comes back with `importError`.
        const sessions = sessionIds
            ? await readDshSessionTranscriptsByIds(sessionIds)
            : listDshSessionSummaries()
        return sessions.map((session) => toItem(session)) as Array<LocalTranscriptSummary | LocalTranscript>
    }
}
