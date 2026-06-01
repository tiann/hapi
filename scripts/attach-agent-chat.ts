#!/usr/bin/env bun
/**
 * Find a legacy agent chat UUID and attach it to HAPI (spawn or reconnect merge).
 * Optional transcript backfill into ~/.hapi/hapi.db for empty HAPI scrollback.
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'

import { backfillSessionMessages, resolveTranscriptPath } from './backfill-agent-transcript'

type AgentFlavor = 'cursor' | 'claude' | 'codex'

type IndexRow = {
    n?: number
    agent?: string
    id: string
    project?: string
}

type HapiSessionRow = {
    id: string
    active: number
    metadata: string | null
    messageCount: number
}

function argValue(name: string): string | undefined {
    const i = process.argv.indexOf(name)
    if (i >= 0) return process.argv[i + 1]
    const prefix = `${name}=`
    const hit = process.argv.find((a) => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : undefined
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag)
}

function expandHome(path: string): string {
    return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function usage(): never {
    console.error(`Usage: attach-agent-chat.sh <chat-uuid|index#|prefix> [options]

Options:
  --dry-run           Plan only; no hub spawn/resume or sqlite writes
  --no-backfill       Skip transcript import into HAPI messages
  --backfill-only     Only backfill (requires --session)
  --local             Use \`hapi <agent> resume\` in project dir instead of hub spawn
  --session <id>      Target HAPI session (backfill-only or force reconnect row)
  --name <label>      HAPI session display name (default: inferred from project + first user turn)
  --agent <flavor>    cursor | claude | codex (auto-detect when omitted)
  --project <path>    Workspace directory for spawn (default from index/transcript)
`)
    process.exit(2)
}

function loadIndex(path: string): IndexRow[] {
    if (!existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8')) as IndexRow[] | { chats: IndexRow[] }
    return Array.isArray(raw) ? raw : raw.chats ?? []
}

function resolveFromIndex(token: string, indexPath: string): IndexRow | null {
    const rows = loadIndex(indexPath)
    if (rows.length === 0) return null

    if (/^\d+$/.test(token)) {
        const n = Number(token)
        return rows.find((r) => r.n === n) ?? null
    }

    const needle = token.toLowerCase()
    const exact = rows.find((r) => r.id.toLowerCase() === needle)
    if (exact) return exact

    const matches = rows.filter((r) => r.id.toLowerCase().startsWith(needle))
    if (matches.length === 1) return matches[0]!
    return null
}

function detectAgent(chatId: string, explicit?: string): AgentFlavor {
    if (explicit && ['cursor', 'claude', 'codex'].includes(explicit)) {
        return explicit as AgentFlavor
    }
    if (resolveTranscriptPath('cursor', chatId)) return 'cursor'
    if (resolveTranscriptPath('claude', chatId)) return 'claude'
    if (resolveTranscriptPath('codex', chatId)) return 'codex'
    return 'cursor'
}

function metadataAgentId(metadata: Record<string, unknown>, agent: AgentFlavor): string | null {
    if (agent === 'cursor') return typeof metadata.cursorSessionId === 'string' ? metadata.cursorSessionId : null
    if (agent === 'claude') return typeof metadata.claudeSessionId === 'string' ? metadata.claudeSessionId : null
    if (agent === 'codex') return typeof metadata.codexSessionId === 'string' ? metadata.codexSessionId : null
    return null
}

function findHapiSessions(dbPath: string, chatId: string, agent: AgentFlavor): HapiSessionRow[] {
    const db = new Database(dbPath, { readonly: true })
    const field = agent === 'cursor' ? 'cursorSessionId'
        : agent === 'claude' ? 'claudeSessionId' : 'codexSessionId'
    const rows = db.prepare(`
        SELECT s.id, s.active, s.metadata,
               (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS messageCount
        FROM sessions s
        WHERE s.metadata LIKE ?
           OR s.metadata LIKE ?
    `).all(`%"${field}":"${chatId}"%`, `%"${field}": "${chatId}"%`) as Array<{
        id: string
        active: number
        metadata: string | null
        messageCount: number
    }>
    db.close()

    const needle = chatId.toLowerCase()
    return rows.filter((row) => {
        if (!row.metadata) return false
        try {
            const md = JSON.parse(row.metadata) as Record<string, unknown>
            const linked = metadataAgentId(md, agent)
            return linked?.toLowerCase() === needle
        } catch {
            return false
        }
    })
}

function hubAuth(hub: string, settingsPath: string): string {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { cliApiToken: string }
    const res = spawnSync('curl', [
        '-fsS', '-X', 'POST', `${hub}/api/auth`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ accessToken: settings.cliApiToken })
    ], { encoding: 'utf8' })
    if (res.status !== 0) {
        throw new Error(`hub auth failed: ${res.stderr || res.stdout}`)
    }
    return (JSON.parse(res.stdout) as { token: string }).token
}

function hubSpawn(opts: {
    hub: string
    token: string
    machineId: string
    directory: string
    agent: AgentFlavor
    resumeSessionId: string
    yolo?: boolean
}): { sessionId?: string; raw: unknown } {
    const body = {
        directory: opts.directory,
        agent: opts.agent,
        resumeSessionId: opts.resumeSessionId,
        yolo: opts.yolo ?? true
    }
    const res = spawnSync('curl', [
        '-fsS', '-X', 'POST', `${opts.hub}/api/machines/${opts.machineId}/spawn`,
        '-H', `Authorization: Bearer ${opts.token}`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify(body)
    ], { encoding: 'utf8' })
    if (res.status !== 0) {
        throw new Error(`spawn failed: ${res.stderr || res.stdout}`)
    }
    const raw = JSON.parse(res.stdout) as { sessionId?: string; type?: string; message?: string }
    return { sessionId: raw.sessionId, raw }
}

function extractCursorText(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content.map((part) => {
        if (!part || typeof part !== 'object') return ''
        const p = part as { type?: string; text?: string }
        return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
    }).filter(Boolean).join('\n')
}

function stripTranscriptMarkup(text: string): string {
    return text
        .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, ' ')
        .replace(/<user_query>/gi, ' ')
        .replace(/<\/user_query>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

function inferSessionName(_projectPath: string, agent: AgentFlavor, chatId: string, override?: string): string {
    if (override?.trim()) return override.trim().slice(0, 255)

    const transcriptPath = resolveTranscriptPath(agent, chatId)
    if (!transcriptPath) return 'Legacy chat'

    const raw = readFileSync(transcriptPath, 'utf8')
    for (const line of raw.split('\n').slice(0, 120)) {
        if (!line.trim()) continue
        let row: Record<string, unknown>
        try {
            row = JSON.parse(line) as Record<string, unknown>
        } catch {
            continue
        }
        if (row.role !== 'user') continue
        const message = row.message as { content?: unknown } | undefined
        const text = stripTranscriptMarkup(extractCursorText(message?.content))
        if (!text) continue

        if (/\bxerox\b/i.test(text) && /\b6510\b/i.test(text)) {
            return 'Xerox Phaser 6510 power setup'.slice(0, 255)
        }
        if (/\bphaser\s*6510\b/i.test(text)) {
            return 'Xerox Phaser 6510'.slice(0, 255)
        }

        return (text.length > 52 ? `${text.slice(0, 49)}…` : text).slice(0, 255)
    }

    return 'Legacy chat'
}

function hubRename(hub: string, jwt: string, sessionId: string, name: string): void {
    const res = spawnSync('curl', [
        '-fsS', '-X', 'PATCH', `${hub}/api/sessions/${sessionId}`,
        '-H', `Authorization: Bearer ${jwt}`,
        '-H', 'Content-Type: application/json',
        '-d', JSON.stringify({ name })
    ], { encoding: 'utf8' })
    if (res.status !== 0) {
        throw new Error(`rename failed: ${res.stderr || res.stdout}`)
    }
}

function runLocalResume(agent: AgentFlavor, chatId: string, directory: string, dryRun: boolean): void {
    const cmd = ['hapi', agent, 'resume', chatId, '--yolo']
    console.log(`LOCAL ${cmd.join(' ')} (cwd=${directory})`)
    if (dryRun) return
    const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd: directory, stdio: 'inherit', env: process.env })
    if (res.status !== 0) {
        throw new Error(`hapi ${agent} resume exited ${res.status}`)
    }
}

function runReconnectScript(repoRoot: string, sessionId: string, chatId: string, dryRun: boolean): void {
    const script = join(repoRoot, 'localdocs', 'operator', 'reconnect-session.sh')
    if (!existsSync(script)) {
        throw new Error(`reconnect script missing: ${script}`)
    }
    const args = [script, '--session', sessionId, '--resume', chatId]
    if (dryRun) args.splice(1, 0, '--dry-run')
    console.log(`RECONNECT ${args.join(' ')}`)
    if (dryRun) return
    const res = spawnSync('bash', args, { stdio: 'inherit', env: process.env })
    if (res.status !== 0) {
        throw new Error(`reconnect-session.sh exited ${res.status}`)
    }
}

async function main(): Promise<void> {
    const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
    const token = positional[0]
    if (!token) usage()

    const repoRoot = join(import.meta.dir, '..')
    const settingsPath = expandHome(process.env.HAPI_SETTINGS ?? join(homedir(), '.hapi', 'settings.json'))
    const hub = process.env.HAPI_HUB_URL ?? 'http://127.0.0.1:3006'
    const dbPath = expandHome(process.env.HAPI_DB ?? join(homedir(), '.hapi', 'hapi.db'))
    const indexPath = expandHome(process.env.HAPI_CHAT_INDEX ?? join(homedir(), '.hapi', 'operator', 'reconnectable-agent-chats.json'))

    const dryRun = hasFlag('--dry-run')
    const noBackfill = hasFlag('--no-backfill')
    const backfillOnly = hasFlag('--backfill-only')
    const local = hasFlag('--local')
    const forceSession = argValue('--session')
    const explicitAgent = argValue('--agent')
    const explicitProject = argValue('--project')
    const explicitName = argValue('--name')

    const indexHit = resolveFromIndex(token.replace(/^#/, ''), indexPath)
    const chatId = (indexHit?.id ?? token).trim()
    const agent = detectAgent(chatId, explicitAgent ?? indexHit?.agent)
    const projectPath = explicitProject
        ? expandHome(explicitProject)
        : indexHit?.project
            ? expandHome(indexHit.project)
            : homedir()

    if (!resolveTranscriptPath(agent, chatId) && !backfillOnly) {
        console.warn(`warn: no transcript file found for ${agent} ${chatId} (attach may still work)`)
    }

    const report: Record<string, unknown> = {
        agentChatId: chatId,
        agent,
        projectPath,
        pathTaken: null as string | null,
        hapiSessionId: null as string | null,
        sessionName: null as string | null,
        messagesInSqlite: 0,
        backfill: null as unknown
    }

    if (backfillOnly) {
        if (!forceSession) {
            throw new Error('--backfill-only requires --session <hapiSessionId>')
        }
        const bf = backfillSessionMessages({
            dbPath,
            sessionId: forceSession,
            agent,
            chatId,
            dryRun,
            force: hasFlag('--force')
        })
        report.pathTaken = 'backfill-only'
        report.hapiSessionId = forceSession
        report.backfill = bf
        report.messagesInSqlite = bf.inserted
        console.log(JSON.stringify(report, null, 2))
        return
    }

    const existing = forceSession
        ? [{ id: forceSession, active: 0, metadata: null, messageCount: 0 }]
        : findHapiSessions(dbPath, chatId, agent)

    if (existing.length > 0) {
        const best = [...existing].sort((a, b) => b.messageCount - a.messageCount)[0]!
        report.hapiSessionId = best.id
        report.messagesInSqlite = best.messageCount

        if (best.messageCount > 0 && !best.active) {
            report.pathTaken = 'reconnect-merge'
            runReconnectScript(repoRoot, best.id, chatId, dryRun)
        } else if (best.active) {
            report.pathTaken = 'already-active'
            console.log(`session ${best.id} already active`)
        } else {
            report.pathTaken = 'reconnect-empty'
            runReconnectScript(repoRoot, best.id, chatId, dryRun)
        }
    } else {
        if (local) {
            report.pathTaken = 'local-resume'
            runLocalResume(agent, chatId, projectPath, dryRun)
        } else {
            const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { cliApiToken: string; machineId?: string }
            const machineId = settings.machineId
            if (!machineId) {
                throw new Error(`machineId missing in ${settingsPath}; use --local or set machineId`)
            }
            report.pathTaken = 'hub-spawn'
            if (dryRun) {
                console.log(`DRY-RUN spawn ${agent} resume=${chatId} dir=${projectPath}`)
            } else {
                const tokenJwt = process.env.HAPI_JWT ?? hubAuth(hub, settingsPath)
                const spawned = hubSpawn({
                    hub,
                    token: tokenJwt,
                    machineId,
                    directory: projectPath,
                    agent,
                    resumeSessionId: chatId
                })
                report.hapiSessionId = spawned.sessionId ?? null
            }
        }
    }

    const sessionForBackfill = typeof report.hapiSessionId === 'string' ? report.hapiSessionId : forceSession
    if (!noBackfill && sessionForBackfill) {
        const db = new Database(dbPath, { readonly: true })
        const row = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionForBackfill) as { c: number }
        db.close()
        if (row.c === 0 || hasFlag('--force')) {
            try {
                const bf = backfillSessionMessages({
                    dbPath,
                    sessionId: sessionForBackfill,
                    agent,
                    chatId,
                    dryRun,
                    force: row.c > 0
                })
                report.backfill = bf
                report.messagesInSqlite = row.c + (dryRun ? bf.total : bf.inserted)
            } catch (error) {
                report.backfill = { error: error instanceof Error ? error.message : String(error) }
            }
        }
    }

    const sessionToName = typeof report.hapiSessionId === 'string' ? report.hapiSessionId : forceSession
    if (sessionToName) {
        const sessionName = inferSessionName(projectPath, agent, chatId, explicitName)
        report.sessionName = sessionName
        if (dryRun) {
            console.log(`DRY-RUN rename ${sessionToName} -> ${sessionName}`)
        } else {
            const jwt = process.env.HAPI_JWT ?? hubAuth(hub, settingsPath)
            hubRename(hub, jwt, sessionToName, sessionName)
        }
    }

    console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
})
