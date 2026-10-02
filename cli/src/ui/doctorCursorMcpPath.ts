/**
 * Cursor HAPI MCP invoke-path probes for `hapi doctor inline-media`.
 *
 * HappyServer up (`hapiMcpUrl`) is necessary but not sufficient — Cursor loads
 * MCP from the ACP agent process PWD + project mcp.json. These checks catch the
 * failure modes where discovery looks ready but CallDynamicTool cannot connect
 * (heavygee/hapi#193 / #194).
 */

import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { CURSOR_HAPI_MCP_SERVER_ID, cursorHapiMcpServerId } from '@/cursor/utils/cursorMcpOverlay'

export type CursorMcpPathSession = {
    id: string
    path: string | null
    hapiMcpUrl: string | null
}

export type CursorMcpPathFailure = {
    code:
        | 'missing_session_path'
        | 'missing_hapi_mcp_url'
        | 'agent_not_found'
        | 'agent_cwd_mismatch'
        | 'project_mcp_missing'
        | 'project_mcp_no_mailbox'
        | 'mailbox_url_mismatch'
        | 'mailbox_not_listening'
        | 'stdio_child_missing'
        | 'stdio_child_url_mismatch'
    detail: string
}

export type CursorMcpPathProbeResult = {
    sessionId: string
    ok: boolean
    failures: CursorMcpPathFailure[]
    agentPid: number | null
    agentCwd: string | null
    projectMcpKeys: string[]
    mailboxKey: string | null
    mailboxUrl: string | null
    stdioChildUrl: string | null
}

export type CursorMcpPathDeps = {
    findCliPidForSession: (sessionId: string) => number | null
    findAgentPid: (cliPid: number) => number | null
    readCwd: (pid: number) => string | null
    readProjectMcpServers: (sessionPath: string) => Record<string, { url?: string }> | null
    findMcpChildUrl: (agentPid: number) => string | null
    isUrlListening: (url: string) => boolean
}

type McpJsonShape = {
    mcpServers?: Record<string, {
        command?: string
        args?: string[]
        url?: string
    }>
}

function normalizeUrl(url: string): string {
    return url.trim().replace(/\/?$/, '/')
}

export function extractMcpUrlFromArgs(args: string[] | undefined): string | null {
    if (!args) return null
    const idx = args.indexOf('--url')
    if (idx < 0 || idx + 1 >= args.length) return null
    const raw = args[idx + 1]
    return typeof raw === 'string' && raw.trim() ? normalizeUrl(raw) : null
}

export function pickSessionMailbox(
    servers: Record<string, { url?: string }>,
    sessionId: string,
): { key: string; url: string } | null {
    const bare = servers[CURSOR_HAPI_MCP_SERVER_ID]
    if (bare?.url) {
        return { key: CURSOR_HAPI_MCP_SERVER_ID, url: normalizeUrl(bare.url) }
    }
    const scoped = cursorHapiMcpServerId(sessionId)
    const scopedEntry = servers[scoped]
    if (scopedEntry?.url) {
        return { key: scoped, url: normalizeUrl(scopedEntry.url) }
    }
    return null
}

function samePath(a: string, b: string): boolean {
    const normalize = (p: string): string => {
        const trimmed = p.replace(/\/$/, '')
        try {
            return realpathSync(trimmed)
        } catch {
            return trimmed
        }
    }
    return normalize(a) === normalize(b)
}

export function evaluateCursorMcpPath(
    session: CursorMcpPathSession,
    deps: CursorMcpPathDeps,
): CursorMcpPathProbeResult {
    const failures: CursorMcpPathFailure[] = []
    const sessionId = session.id

    if (!session.path?.trim()) {
        failures.push({ code: 'missing_session_path', detail: 'session metadata.path is missing' })
    }
    if (!session.hapiMcpUrl?.trim()) {
        failures.push({ code: 'missing_hapi_mcp_url', detail: 'session metadata.hapiMcpUrl is missing' })
    }

    const expectedUrl = session.hapiMcpUrl ? normalizeUrl(session.hapiMcpUrl) : null
    let agentPid: number | null = null
    let agentCwd: string | null = null
    let projectMcpKeys: string[] = []
    let mailboxKey: string | null = null
    let mailboxUrl: string | null = null
    let stdioChildUrl: string | null = null

    const cliPid = deps.findCliPidForSession(sessionId)
    if (cliPid !== null) {
        agentPid = deps.findAgentPid(cliPid)
    }
    if (agentPid === null) {
        failures.push({
            code: 'agent_not_found',
            detail: 'no live Cursor ACP agent process found for this session',
        })
    } else {
        agentCwd = deps.readCwd(agentPid)
        if (session.path && agentCwd && !samePath(agentCwd, session.path)) {
            failures.push({
                code: 'agent_cwd_mismatch',
                detail: `agent cwd=${agentCwd} expected=${session.path} (Cursor MCP loads from process PWD)`,
            })
        }
        stdioChildUrl = deps.findMcpChildUrl(agentPid)
    }

    if (session.path) {
        const servers = deps.readProjectMcpServers(session.path)
        if (servers === null) {
            failures.push({
                code: 'project_mcp_missing',
                detail: `missing ${join(session.path, '.cursor/mcp.json')}`,
            })
        } else {
            projectMcpKeys = Object.keys(servers).sort()
            const mailbox = pickSessionMailbox(servers, sessionId)
            if (!mailbox) {
                failures.push({
                    code: 'project_mcp_no_mailbox',
                    detail: `no bare \`${CURSOR_HAPI_MCP_SERVER_ID}\` (or hapi-<sessionId>) mailbox in project mcp.json; keys=${projectMcpKeys.join(',') || '(none)'}`,
                })
            } else {
                mailboxKey = mailbox.key
                mailboxUrl = mailbox.url
                if (expectedUrl && mailbox.url !== expectedUrl) {
                    failures.push({
                        code: 'mailbox_url_mismatch',
                        detail: `project ${mailbox.key} → ${mailbox.url} but hapiMcpUrl=${expectedUrl}`,
                    })
                }
                if (!deps.isUrlListening(mailbox.url)) {
                    failures.push({
                        code: 'mailbox_not_listening',
                        detail: `${mailbox.url} is not accepting connections`,
                    })
                }
            }
        }
    }

    if (agentPid !== null) {
        if (!stdioChildUrl) {
            failures.push({
                code: 'stdio_child_missing',
                detail: 'no MCP stdio child (`hapi mcp --url`) under the agent — Cursor may show Not connected',
            })
        } else if (expectedUrl && normalizeUrl(stdioChildUrl) !== expectedUrl) {
            failures.push({
                code: 'stdio_child_url_mismatch',
                detail: `stdio child --url=${normalizeUrl(stdioChildUrl)} expected=${expectedUrl}`,
            })
        }
    }

    return {
        sessionId,
        ok: failures.length === 0,
        failures,
        agentPid,
        agentCwd,
        projectMcpKeys,
        mailboxKey,
        mailboxUrl,
        stdioChildUrl,
    }
}

function readProcCmdline(pid: number): string {
    try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
    } catch {
        return ''
    }
}

function listProcPids(): number[] {
    try {
        return readdirSync('/proc')
            .filter((name) => /^\d+$/.test(name))
            .map((name) => Number(name))
    } catch {
        return []
    }
}

function childrenOf(parentPid: number): number[] {
    const kids: number[] = []
    for (const pid of listProcPids()) {
        try {
            const status = readFileSync(`/proc/${pid}/status`, 'utf8')
            const match = /^PPid:\s+(\d+)/m.exec(status)
            if (match && Number(match[1]) === parentPid) {
                kids.push(pid)
            }
        } catch {
            // race: process exited
        }
    }
    return kids
}

export function createDefaultCursorMcpPathDeps(): CursorMcpPathDeps {
    return {
        findCliPidForSession(sessionId: string): number | null {
            const needle = sessionId.slice(0, 8)
            for (const pid of listProcPids()) {
                const cmd = readProcCmdline(pid)
                if (!cmd.includes('cursor') || !cmd.includes(needle)) continue
                // Prefer the HAPI CLI wrapper (bun … cursor … session), not the agent index.js.
                if (cmd.includes('index.js') && !cmd.includes('hapi') && !cmd.includes('cli/src')) {
                    continue
                }
                if (cmd.includes('mcp --url') || cmd.includes('mcp\0--url')) continue
                return pid
            }
            return null
        },
        findAgentPid(cliPid: number): number | null {
            const queue = [...childrenOf(cliPid)]
            const seen = new Set<number>()
            while (queue.length > 0) {
                const pid = queue.shift()!
                if (seen.has(pid)) continue
                seen.add(pid)
                const cmd = readProcCmdline(pid)
                if (cmd.includes('index.js') || cmd.includes('agent')) {
                    // Prefer ACP agent over mcp child
                    if (!cmd.includes('mcp --url') && !cmd.includes(' mcp ')) {
                        return pid
                    }
                }
                queue.push(...childrenOf(pid))
            }
            return null
        },
        readCwd(pid: number): string | null {
            try {
                return readlinkSync(`/proc/${pid}/cwd`)
            } catch {
                return null
            }
        },
        readProjectMcpServers(sessionPath: string) {
            const mcpPath = join(sessionPath, '.cursor', 'mcp.json')
            if (!existsSync(mcpPath)) return null
            try {
                const raw = JSON.parse(readFileSync(mcpPath, 'utf8')) as McpJsonShape
                const servers = raw.mcpServers ?? {}
                const out: Record<string, { url?: string }> = {}
                for (const [key, entry] of Object.entries(servers)) {
                    const url = extractMcpUrlFromArgs(entry.args) ?? (typeof entry.url === 'string' ? normalizeUrl(entry.url) : undefined)
                    out[key] = { url }
                }
                return out
            } catch {
                return null
            }
        },
        findMcpChildUrl(agentPid: number): string | null {
            const queue = [...childrenOf(agentPid)]
            const seen = new Set<number>()
            while (queue.length > 0) {
                const pid = queue.shift()!
                if (seen.has(pid)) continue
                seen.add(pid)
                const cmd = readProcCmdline(pid)
                if (cmd.includes('mcp') && cmd.includes('--url')) {
                    const match = /https?:\/\/127\.0\.0\.1:\d+\/?/.exec(cmd)
                    if (match) return normalizeUrl(match[0])
                }
                queue.push(...childrenOf(pid))
            }
            return null
        },
        isUrlListening(url: string): boolean {
            try {
                const parsed = new URL(url)
                const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
                if (!Number.isFinite(port) || port <= 0) return false
                // Prefer /proc/net/tcp listen table when available (no connect race).
                const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
                for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
                    if (!existsSync(table)) continue
                    const body = readFileSync(table, 'utf8')
                    for (const line of body.split('\n').slice(1)) {
                        const cols = line.trim().split(/\s+/)
                        if (cols.length < 4) continue
                        const local = cols[1] // ip:port hex
                        const state = cols[3]
                        if (state !== '0A') continue // TCP_LISTEN
                        if (local.endsWith(`:${hexPort}`)) return true
                    }
                }
                return false
            } catch {
                return false
            }
        },
    }
}
