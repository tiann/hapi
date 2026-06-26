#!/usr/bin/env bun
/**
 * Post a local image or video inline to a HAPI session via display_image / display_video MCP.
 *
 * Uses session.metadata.hapiMcpUrl (published at MCP server start) so we hit the MCP
 * endpoint, not the session hook server on another loopback port in the same process.
 *
 * Usage:
 *   bun scripts/tooling/hapi-display-image.mjs <session-id-prefix> <media-path> [title]
 *
 * Picks display_video for mp4/webm (ftyp / webm magic), else display_image.
 */

import { readFileSync, lstatSync, existsSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const HAPI_HOST = process.env.HAPI_HOST ?? 'http://localhost:3006'
const SETTINGS = process.env.HAPI_SETTINGS ?? `${process.env.HOME}/.hapi/settings.json`

const envSessionPrefix = process.env.HAPI_SESSION_ID ? process.env.HAPI_SESSION_ID.slice(0, 8) : undefined
let sessionArg = process.argv[2]
let imagePath = process.argv[3]
let title = process.argv[4]

// HAPI_SESSION_ID + path-only: hapi-display-image.mjs <media-path> [title]
if (envSessionPrefix && sessionArg && existsSync(sessionArg) && lstatSync(sessionArg).isFile()) {
    imagePath = sessionArg
    title = process.argv[3]
    sessionArg = envSessionPrefix
} else if (!sessionArg && envSessionPrefix) {
    sessionArg = envSessionPrefix
}

if (!sessionArg || !imagePath) {
    console.error('usage: hapi-display-image.mjs <session-id-prefix> <media-path> [title]')
    console.error('  or: HAPI_SESSION_ID=<uuid> hapi-display-image.mjs <media-path> [title]')
    process.exit(2)
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

function detectMediaTool(path) {
    const head = readFileSync(path).subarray(0, 16)
    if (head.length >= 12 && head.subarray(4, 8).toString('ascii') === 'ftyp') {
        const brand = head.subarray(8, 12).toString('ascii')
        return brand === 'avif' || brand === 'avis' ? 'display_image' : 'display_video'
    }
    if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
        return 'display_video'
    }
    return 'display_image'
}

if (!lstatSync(imagePath).isFile()) {
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

const sessionsRes = await fetch(`${HAPI_HOST}/api/sessions?limit=500`, {
    headers: { Authorization: `Bearer ${jwt}` },
})
const sessionsBody = await sessionsRes.json()
const sessions = sessionsBody.sessions ?? sessionsBody
const session = sessions.find((s) => sessionMatchesPrefix(s, sessionArg))
if (!session) {
    console.error(`no session for prefix ${sessionArg} (use HAPI session id from /sessions/<uuid>, not cursorSessionId alone)`)
    process.exit(4)
}

// List endpoint may omit hapiMcpUrl until hub summary includes it; per-session GET always has it.
let mcpUrl = session.metadata?.hapiMcpUrl
if (!mcpUrl) {
    const detailRes = await fetch(`${HAPI_HOST}/api/sessions/${encodeURIComponent(session.id)}`, {
        headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!detailRes.ok) {
        console.error('session detail fetch failed', detailRes.status)
        process.exit(5)
    }
    const detailBody = await detailRes.json()
    const detail = detailBody.session ?? detailBody
    mcpUrl = detail.metadata?.hapiMcpUrl
}
if (!mcpUrl) {
    console.error('session has no hapiMcpUrl metadata (happy MCP not running in that session CLI — check GET /api/sessions/:id)')
    process.exit(5)
}

console.error(`hapi-display-image: session=${session.id} mcp=${mcpUrl}`)

const mediaTool = detectMediaTool(imagePath)
const client = new Client({ name: 'hapi-display-image', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
await client.connect(transport)
const result = await client.callTool({
    name: mediaTool,
    arguments: { path: imagePath, title: title ?? undefined },
})
await client.close()
console.log(JSON.stringify(result, null, 2))
