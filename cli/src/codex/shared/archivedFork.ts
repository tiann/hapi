import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ForkArchivedCodexRequest, ForkArchivedCodexResponse } from '@hapi/protocol/apiTypes'
import { ApiClient } from '@/api/api'
import { CodexAppServerClient } from '../codexAppServerClient'
import { initializeSharedClient } from './launch'
import { codexHome, withThreadOwnership } from './registry'
import { record, string } from './gateway'

const JournalSchema = z.object({
    request: z.object({ operationId: z.string(), sourceSessionId: z.string(), sourceThreadId: z.string(), directory: z.string(),
        boundary: z.object({ localId: z.string(), turnId: z.string() }).optional() }),
    restoreRequired: z.boolean(), forkIssued: z.boolean(), nativeSessionId: z.string().optional(), done: z.boolean()
})
export type ArchivedForkJournal = z.infer<typeof JournalSchema>
type NativeClient = Pick<CodexAppServerClient, 'request'>

async function readHistory(client: NativeClient, threadId: string): Promise<Record<string, unknown>> {
    let thread = record(record(await client.request('thread/read', { threadId, includeTurns: false })).thread)
    if (thread.historyMode === 'paginated') {
        const turns: unknown[] = []
        let cursor: string | undefined
        do {
            const page = record(await client.request('thread/turns/list', { threadId, cursor, sortDirection: 'asc', itemsView: 'full' }))
            if (!Array.isArray(page.data)) throw new Error('Invalid native history page')
            turns.push(...page.data)
            cursor = string(page.nextCursor)
        } while (cursor)
        thread.turns = turns
    } else thread = record(record(await client.request('thread/read', { threadId, includeTurns: true })).thread)
    return thread
}

/** Separated from transport/locks so failure and recovery paths are testable. */
export async function performArchivedFork(
    client: NativeClient, request: ForkArchivedCodexRequest, journal: ArchivedForkJournal,
    save: () => Promise<void>, assertSourceInactive: () => Promise<void>
): Promise<string> {
    if (JSON.stringify(journal.request) !== JSON.stringify(request)) throw new Error('Archived fork reservation does not match this request')
    if (journal.done && journal.nativeSessionId) return journal.nativeSessionId
    const restoreSource = async () => {
        if (!journal.restoreRequired) return
        await assertSourceInactive()
        const loaded = record(await client.request('thread/loaded/list', {}))
        if (!Array.isArray(loaded.data) || loaded.data.includes(request.sourceThreadId)) {
            throw new Error('Source was loaded during archived fork; refuse to archive a potentially active conversation')
        }
        await client.request('thread/archive', { threadId: request.sourceThreadId })
        journal.restoreRequired = false
        await save()
    }
    // A previous process may have died after unarchive or after creating a child.
    // Restore first; a dispatched fork without a returned id must never replay.
    await restoreSource()
    if (journal.forkIssued && !journal.nativeSessionId) {
        throw new Error('Previous native fork outcome is unconfirmed; inspect the operation before retrying')
    }
    if (!journal.nativeSessionId) {
        await assertSourceInactive()
        const source = await readHistory(client, request.sourceThreadId)
        if (source.id !== request.sourceThreadId || source.parentThreadId) throw new Error('Archived fork requires an exact native root thread')
        if (resolve(string(source.cwd) ?? '') !== resolve(request.directory)) throw new Error('Native source directory does not match the HAPI session')
        if (record(source.status).type !== 'notLoaded') throw new Error('Native source is loaded; stop it before forking archived history')
        if (request.boundary) {
            const turns = (Array.isArray(source.turns) ? source.turns : []).map(record)
            const index = turns.findIndex(turn => turn.id === request.boundary!.turnId)
            const selected = turns[index]
            const user = (Array.isArray(selected?.items) ? selected.items.map(record) : []).find(item => item.type === 'userMessage')
            const localId = string(user?.clientId ?? user?.clientUserMessageId)
                ?? (user?.id ? `codex:${request.sourceThreadId}:user:${user.id}` : undefined)
            if (index < 0 || localId !== request.boundary.localId
                || turns.slice(0, index + 1).some(turn => !['completed', 'interrupted', 'failed'].includes(string(turn.status) ?? ''))) {
                throw new Error('Historical fork boundary is missing, unfinished, or inside a steered native turn')
            }
        }
        const fork = async () => {
            await assertSourceInactive()
            journal.forkIssued = true
            await save()
            const response = record(await client.request('thread/fork', {
                threadId: request.sourceThreadId,
                ...(request.boundary ? { beforeTurnId: request.boundary.turnId } : {}),
                deferGoalContinuation: true, excludeTurns: true
            }))
            const child = record(response.thread)
            const id = string(child.id)
            if (!id || id === request.sourceThreadId || child.parentThreadId === request.sourceThreadId) {
                throw new Error('Native fork did not create an independent root')
            }
            journal.nativeSessionId = id
            await save()
        }
        try {
            try { await fork() }
            catch (error) {
                // Only an explicit archived rejection proves no fork occurred.
                if (!(error instanceof Error) || !error.message.startsWith(`session ${request.sourceThreadId} is archived.`)) throw error
                journal.forkIssued = false
                journal.restoreRequired = true
                await save()
                await assertSourceInactive()
                await client.request('thread/unarchive', { threadId: request.sourceThreadId })
                await fork()
            }
        } finally { await restoreSource() }
    }
    // Release the temporary server's writer through native archive. The child
    // launcher unarchives this exact id; no source resume or model turn occurs.
    await client.request('thread/archive', { threadId: journal.nativeSessionId })
    journal.done = true
    await save()
    return journal.nativeSessionId!
}

export async function forkArchivedCodex(request: ForkArchivedCodexRequest, allowsDirectory: () => Promise<boolean>): Promise<ForkArchivedCodexResponse> {
    const home = codexHome()
    const journalDirectory = join(home, 'hapi-archived-forks')
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 })
    const target = join(journalDirectory, `${request.operationId}.json`)
    const loadJournal = async (): Promise<ArchivedForkJournal> => {
        try { return JournalSchema.parse(JSON.parse(await readFile(target, 'utf8'))) }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            return { request, restoreRequired: false, forkIssued: false, done: false }
        }
    }
    const failure = (error: unknown, journal?: ArchivedForkJournal): ForkArchivedCodexResponse => ({
        error: error instanceof Error ? error.message : String(error),
        rollbackSafe: Boolean(journal && !journal.forkIssued && !journal.restoreRequired && !journal.nativeSessionId)
    })
    return withThreadOwnership(home, request.sourceThreadId, `archived-fork:${request.operationId}`, async () => {
        const api = await ApiClient.create()
        const assertSourceInactive = async () => {
            const source = await api.getSession(request.sourceSessionId)
            if (source.active || source.metadata?.codexSessionId !== request.sourceThreadId
                || source.metadata?.codexArchivedFork?.operationId !== request.operationId) {
                throw new Error('Source session changed during archived fork')
            }
        }
        const journal = await loadJournal()
        const save = async () => {
            const temporary = `${target}.${randomUUID()}.tmp`
            await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 })
            await rename(temporary, target)
        }
        const client = new CodexAppServerClient({ cwd: request.directory })
        client.setServerRequestHandler(() => {})
        try {
            // Report policy rejection against the persisted journal: a fresh
            // attempt is safe to release, but interrupted native work is not.
            if (!await allowsDirectory()) throw new Error('Directory is outside workspace roots')
            await initializeSharedClient(client)
            return { nativeSessionId: await performArchivedFork(client, request, journal, save, assertSourceInactive) }
        } catch (error) {
            return failure(error, journal)
        } finally { await client.disconnect({ gracefulTimeoutMs: 2_000 }) }
    }, async error => {
        try { return failure(error, await loadJournal()) }
        catch { return failure(error) } // Unreadable journals cannot prove rollback safe.
    })
}
