import type { LocalSessionFlavor, LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'

/**
 * CLI-side local session source. Each flavor adapts its disk reader to the
 * normalized transcript contract; the registry feeds them to the single
 * ListLocalSessions RPC handler.
 */

export type LocalSessionSourceListParams = {
    cwd: string | null
    /** Null -> summaries only; otherwise transcripts for exactly these ids. */
    sessionIds: string[] | null
}

export type LocalSessionSourceListItem = LocalTranscriptSummary | LocalTranscript

export type CliLocalSessionSource = {
    flavor: LocalSessionFlavor
    list(params: LocalSessionSourceListParams):
        | LocalSessionSourceListItem[]
        | Promise<LocalSessionSourceListItem[]>
}

export type LocalSessionHandlerDeps = {
    registerHandler: <Request, Response>(
        method: string,
        handler: (params: Request) => Promise<Response> | Response
    ) => void
    resolveForCheck(path: string): Promise<string>
    isWithinSpawnRoots(path: string): boolean
    isSessionWithinWorkspaceRoots(session: { cwd?: string | null }): Promise<boolean>
}