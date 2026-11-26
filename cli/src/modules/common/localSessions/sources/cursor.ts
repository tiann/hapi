import { homedir } from 'node:os'
import type { LocalTranscript, LocalTranscriptSummary } from '@hapi/protocol/localTranscript'
import type { CliLocalSessionSource, LocalSessionSourceListItem } from '../types'
import type { CursorImportableSessionSummary } from '../../cursorImportSessions'

function toSummary(session: CursorImportableSessionSummary): LocalTranscriptSummary {
    return {
        flavor: 'cursor',
        id: session.id,
        title: session.title,
        lastUserMessage: session.firstUserMessage ?? null,
        cwd: session.workspacePath ?? null,
        file: session.storeDbPath,
        modifiedAt: session.modifiedAt,
        extra: {
            sourceFormat: session.sourceFormat,
            sizeBytes: session.sizeBytes
        }
    }
}

function toTranscript(session: CursorImportableSessionSummary): LocalTranscript {
    // Cursor import attaches the ACP store; hub scrollback comes from ACP
    // resume/replay, not a JSONL-style message backfill.
    return {
        ...toSummary(session),
        messages: []
    }
}

export const cursorLocalSessionSource: CliLocalSessionSource = {
    flavor: 'cursor',
    // Dynamic import: cursorImportSessions pulls bun:sqlite, which Vitest/Node
    // cannot resolve at module-graph time (same pattern as PrepareCursorImport).
    list: async ({ cwd, sessionIds }) => {
        const { listCursorImportableSessionsOnDisk } = await import('../../cursorImportSessions')
        const all = listCursorImportableSessionsOnDisk({
            home: homedir(),
            candidateWorkspacePaths: cwd ? [cwd] : [],
            limit: 500
        })
        const filtered = cwd?.trim()
            ? all.filter((session) => (session.workspacePath ?? '').trim() === cwd.trim())
            : all
        if (!sessionIds) {
            return filtered.map(toSummary) as LocalSessionSourceListItem[]
        }
        const wanted = new Set(sessionIds)
        return filtered
            .filter((session) => wanted.has(session.id))
            .map(toTranscript) as LocalSessionSourceListItem[]
    }
}
