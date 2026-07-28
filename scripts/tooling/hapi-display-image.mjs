#!/usr/bin/env bun
/**
 * Post a local image inline to a HAPI session via the session CLI's display_image MCP tool.
 *
 * Uses session.metadata.hapiMcpUrl (published at MCP server start) so we hit the MCP
 * endpoint, not the session hook server on another loopback port in the same process.
 *
 * Usage:
 *   # inside a wrapped session (self-targets via $HAPI_SESSION_ID — no list):
 *   bun scripts/tooling/hapi-display-image.mjs <image-path> [title]
 *   # explicit self:
 *   bun scripts/tooling/hapi-display-image.mjs self <image-path> [title]
 *   # explicit other session:
 *   bun scripts/tooling/hapi-display-image.mjs <session-id-prefix> <image-path> [title]
 *
 * Self-resolution (tiann/hapi#1119): $HAPI_SESSION_ID → GET /api/sessions/:id directly.
 * Prefer the MCP display_image tool when available; this script is the shell fallback.
 */

import { readFileSync, lstatSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const HAPI_HOST = process.env.HAPI_HOST ?? 'http://localhost:3006'
const SETTINGS = process.env.HAPI_SETTINGS ?? `${process.env.HOME}/.hapi/settings.json`

const SELF_TOKENS = new Set(['self', '@self', '@me', 'current', '-'])

function isFile(p) {
    try {
        return lstatSync(p).isFile()
    } catch {
        return false
    }
}

// Arg shapes (backward compatible):
//   <image> [title]                     → self-target current session
//   <self-token> <image> [title]        → self-target, explicit
//   <session-id-prefix> <image> [title] → explicit session
const args = process.argv.slice(2)
let sessionArg
let imagePath
let title
if (args.length > 0 && isFile(args[0]) && !SELF_TOKENS.has(args[0])) {
    sessionArg = null
    imagePath = args[0]
    title = args[1]
} else {
    sessionArg = args[0]
    imagePath = args[1]
    title = args[2]
}

if (!imagePath) {
    console.error('usage: hapi-display-image.mjs [<session-id-prefix>|self] <image-path> [title]')
    console.error('  or: HAPI_SESSION_ID=<uuid> hapi-display-image.mjs <image-path> [title]')
    process.exit(2)
}

if (!isFile(imagePath)) {
    console.error(`not a file: ${imagePath}`)
    process.exit(2)
}

const token = process.env.CLI_API_TOKEN ?? JSON.parse(readFileSync(SETTINGS, 'utf8')).cliApiToken
if (!token) {
    console.error('missing CLI_API_TOKEN env and no cliApiToken in settings')
    process.exit(2)
}
const authRes = await fetch(`${HAPI_HOST}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: token }),
})
if (!authRes.ok) {
    console.error('auth failed', authRes.status)
    process.exit(3)
}
const { token: jwt } = await authRes.json()
const authHeaders = { Authorization: `Bearer ${jwt}` }

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
    // Preferred path (#1119): direct GET, no /api/sessions list.
    session = await fetchSessionDetail(hapiSessionId)
    if (!session) {
        console.error(`GET /api/sessions/${hapiSessionId} failed (HAPI_SESSION_ID set but hub has no such row)`)
        process.exit(4)
    }
} else {
    // Explicit id/prefix: full uuid → direct GET; otherwise list + prefix match.
    const looksFull = /^[0-9a-f-]{36}$/i.test(sessionArg)
    if (looksFull) {
        session = await fetchSessionDetail(sessionArg)
    }
    if (!session) {
        const sessions = await listSessions()
        const listed = sessions.find((s) => typeof s.id === 'string' && s.id.startsWith(sessionArg))
        if (!listed) {
            console.error(`no session for prefix ${sessionArg}`)
            process.exit(4)
        }
        // List summaries may omit hapiMcpUrl; detail fetch always has it when present.
        session = await fetchSessionDetail(listed.id) ?? listed
    }
}

const mcpUrl = session.metadata?.hapiMcpUrl
if (!mcpUrl) {
    console.error('session has no hapiMcpUrl metadata (restart session CLI after MCP server start)')
    process.exit(5)
}

console.error(`hapi-display-image: session=${session.id} mcp=${mcpUrl}`)

const client = new Client({ name: 'hapi-display-image', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
await client.connect(transport)
const result = await client.callTool({
    name: 'display_image',
    arguments: { path: imagePath, title: title ?? undefined },
})
await client.close()
console.log(JSON.stringify(result, null, 2))
