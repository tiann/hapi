#!/usr/bin/env bun
/**
 * Paint tappable http(s) URL cards into a HAPI session via display_links MCP.
 *
 * Uses session.metadata.hapiMcpUrl (published at MCP server start) so we hit the MCP
 * endpoint, not the session hook server on another loopback port in the same process.
 *
 * Usage:
 *   # inside a wrapped session (self-targets via $HAPI_SESSION_ID — no list):
 *   bun scripts/tooling/hapi-display-links.mjs <href> [title]
 *   bun scripts/tooling/hapi-display-links.mjs --text-stdin [title]
 *   printf '%s' "$secret" | bun scripts/tooling/hapi-display-links.mjs --text-stdin
 * Other-session / cross-runner targeting is refused (loopback MCP).
 *
 * Construct landmine hosts by concatenation in the calling script ("tia"+"nn"),
 * never copy a URL from model prose. http/https only.
 */

import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const HAPI_HOST = process.env.HAPI_HOST ?? process.env.HAPI_API_URL ?? 'http://localhost:3006'
const SETTINGS = process.env.HAPI_SETTINGS ?? `${process.env.HOME}/.hapi/settings.json`

const SELF_TOKENS = new Set(['self', '@self', '@me', 'current', '-'])
const LOCAL_SESSION_ONLY_ERROR =
    'display-links only supports the current local session; run it on the target runner'

function assertLocalDisplayLinksTarget(sessionArg) {
    if (!sessionArg || SELF_TOKENS.has(sessionArg)) {
        return
    }
    const selfSessionId = process.env.HAPI_SESSION_ID?.trim() ?? ''
    if (selfSessionId && (sessionArg === selfSessionId || selfSessionId.startsWith(sessionArg))) {
        return
    }
    throw new Error(LOCAL_SESSION_ONLY_ERROR)
}

/** Mirror shared `buildDisplayLinksToolName` — keep in sync with displayLinks.ts. */
function buildDisplayLinksToolName(sessionId) {
    const id = String(sessionId ?? '').trim().replaceAll('-', '_')
    if (!id) {
        throw new Error('display_links tool name requires a non-empty session id')
    }
    return `hapi_${id}_display_links`
}

function sessionMatchesPrefix(session, prefix) {
    if (typeof session.id === 'string' && session.id.startsWith(prefix)) {
        return true
    }
    const meta = session.metadata ?? {}
    const agentIds = [
        meta.agentSessionId,
        meta.cursorSessionId,
        meta.codexSessionId,
        meta.claudeSessionId,
        meta.geminiSessionId,
        meta.opencodeSessionId,
        meta.kimiSessionId,
    ]
    return agentIds.some((id) => typeof id === 'string' && id.startsWith(prefix))
}

function looksLikeHref(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value)
}

// Arg shapes:
//   <href> [title]
//   <self-token> <href> [title]
//   --text <value> [title]
//   <self-token> --text <value> [title]
const args = process.argv.slice(2)
let sessionArg
let href
let title
let texts
const stdinIndex = args.indexOf('--text-stdin')
const textIndex = args.indexOf('--text')
if (stdinIndex >= 0) {
    if (textIndex >= 0) {
        console.error('use --text or --text-stdin, not both')
        process.exit(2)
    }
    const before = args.slice(0, stdinIndex)
    sessionArg = before[0] && !looksLikeHref(before[0]) ? before[0] : null
    href = null
    title = args[stdinIndex + 1]
    const value = (await Bun.stdin.text()).replace(/\r?\n$/, '')
    if (!value.trim()) {
        console.error('usage: hapi-display-links.mjs [self] --text-stdin [title]')
        process.exit(2)
    }
    texts = title ? [{ value, title }] : [{ value }]
} else if (textIndex >= 0) {
    const value = args[textIndex + 1]
    if (!value) {
        console.error('usage: hapi-display-links.mjs [self] --text <value> [title]')
        process.exit(2)
    }
    const before = args.slice(0, textIndex)
    sessionArg = before[0] && !looksLikeHref(before[0]) ? before[0] : null
    href = null
    title = args[textIndex + 2]
    texts = title ? [{ value, title }] : [{ value }]
} else if (args.length > 0 && looksLikeHref(args[0]) && !SELF_TOKENS.has(args[0])) {
    sessionArg = null
    href = args[0]
    title = args[1]
} else {
    sessionArg = args[0]
    href = args[1]
    title = args[2]
}

if (!href && !(texts && texts.length > 0)) {
    console.error('usage: hapi-display-links.mjs [self] <href> [title]')
    console.error('  or: hapi-display-links.mjs [self] --text <value> [title]')
    console.error('  or: hapi-display-links.mjs [self] --text-stdin [title]  (secrets: not on argv)')
    console.error('  or: HAPI_SESSION_ID=<uuid> hapi-display-links.mjs <href> [title]')
    process.exit(2)
}

try {
    assertLocalDisplayLinksTarget(sessionArg)
} catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(4)
}

const token = process.env.CLI_API_TOKEN ?? JSON.parse(readFileSync(SETTINGS, 'utf8')).cliApiToken
if (!token) {
    console.error('missing CLI_API_TOKEN env and no cliApiToken in settings')
    process.exit(2)
}

function loadExtraHeaders() {
    const envRaw = process.env.HAPI_EXTRA_HEADERS_JSON
    if (envRaw !== undefined) {
        try {
            const parsed = JSON.parse(envRaw)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return Object.fromEntries(
                    Object.entries(parsed).filter((entry) => typeof entry[1] === 'string'),
                )
            }
        } catch {
            // ignore malformed env JSON; match CLI parseExtraHeaders fail-closed-to-empty
        }
        return {}
    }
    try {
        const settings = JSON.parse(readFileSync(SETTINGS, 'utf8'))
        const extra = settings.extraHeaders
        if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
            return Object.fromEntries(
                Object.entries(extra).filter((entry) => typeof entry[1] === 'string'),
            )
        }
    } catch {
        // settings already parsed for token; missing extraHeaders is fine
    }
    return {}
}

const extraHeaders = loadExtraHeaders()
function withHubHeaders(base) {
    return { ...extraHeaders, ...base }
}

const authRes = await fetch(`${HAPI_HOST}/api/auth`, {
    method: 'POST',
    headers: withHubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ accessToken: token }),
})
if (!authRes.ok) {
    console.error('auth failed', authRes.status)
    process.exit(3)
}
const { token: jwt } = await authRes.json()
const authHeaders = withHubHeaders({ Authorization: `Bearer ${jwt}` })

async function fetchSessionDetail(sessionId) {
    const detailRes = await fetch(`${HAPI_HOST}/api/sessions/${encodeURIComponent(sessionId)}`, {
        headers: authHeaders,
    })
    if (!detailRes.ok) {
        return null
    }
    const detailBody = await detailRes.json()
    return detailBody.session ?? detailBody
}

async function listSessions() {
    const sessionsRes = await fetch(`${HAPI_HOST}/api/sessions?limit=500`, {
        headers: authHeaders,
    })
    const sessionsBody = await sessionsRes.json()
    return sessionsBody.sessions ?? sessionsBody
}

let session
const wantsSelf = !sessionArg || SELF_TOKENS.has(sessionArg)
const hapiSessionId = process.env.HAPI_SESSION_ID?.trim()

if (wantsSelf) {
    if (!hapiSessionId) {
        console.error(
            'cannot self-resolve session: $HAPI_SESSION_ID is not set. '
            + 'Pass an explicit <session-id-prefix>, or run inside a HAPI-wrapped agent session.',
        )
        process.exit(4)
    }
    session = await fetchSessionDetail(hapiSessionId)
    if (!session) {
        console.error(`GET /api/sessions/${hapiSessionId} failed (HAPI_SESSION_ID set but hub has no such row)`)
        process.exit(4)
    }
} else {
    const looksFull = /^[0-9a-f-]{36}$/i.test(sessionArg)
    if (looksFull) {
        session = await fetchSessionDetail(sessionArg)
    }
    if (!session) {
        const sessions = await listSessions()
        const matches = sessions.filter((candidate) => sessionMatchesPrefix(candidate, sessionArg))
        if (matches.length !== 1) {
            console.error(
                matches.length === 0
                    ? `no session for prefix ${sessionArg} (use HAPI session id from /sessions/<uuid>, not cursorSessionId alone)`
                    : `ambiguous session prefix ${sessionArg} (${matches.length} matches); use a full HAPI session id`,
            )
            process.exit(4)
        }
        const listed = matches[0]
        session = await fetchSessionDetail(listed.id) ?? listed
    }
}

const mcpUrl = session.metadata?.hapiMcpUrl
if (!mcpUrl) {
    console.error('session has no hapiMcpUrl metadata (restart session CLI after MCP server start)')
    process.exit(5)
}

console.error(`hapi-display-links: session=${session.id} mcp=${mcpUrl}`)

const client = new Client({ name: 'hapi-display-links', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
await client.connect(transport)
const result = await client.callTool({
    name: buildDisplayLinksToolName(session.id),
    arguments: {
        ...(href ? { urls: title ? [{ href, title }] : [{ href }] } : {}),
        ...(texts && texts.length > 0 ? { texts } : {}),
        sessionId: session.id,
    },
})
await client.close()
console.log(JSON.stringify(result, null, 2))
