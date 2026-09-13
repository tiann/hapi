#!/usr/bin/env bun
/**
 * Mount / unmount preview_* MCP tools against a HAPI session — the shell
 * fallback for exercising the preview feature without an agent in the loop.
 *
 * Uses session.metadata.hapiMcpUrl (published at MCP server start).
 *
 * Usage:
 *   # mount a static directory on the current session:
 *   HAPI_SESSION_ID=<uuid> bun scripts/tooling/hapi-preview.mjs static /tmp/report [name] [ttlHours]
 *   # mount a dev-server proxy:
 *   bun scripts/tooling/hapi-preview.mjs proxy <session-id-prefix> 5173
 *   bun scripts/tooling/hapi-preview.mjs proxy self http://localhost:5173
 *   # unmount:
 *   bun scripts/tooling/hapi-preview.mjs stop self --all
 *   bun scripts/tooling/hapi-preview.mjs stop <session-id-prefix> --name site
 *
 * The tool result contains the public URL; verify with:
 *   curl -si "$URL" | head
 */

import { lstatSync, readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const HAPI_HOST = process.env.HAPI_HOST ?? 'http://localhost:3006'
const SETTINGS = process.env.HAPI_SETTINGS ?? `${process.env.HOME}/.hapi/settings.json`
const SELF_TOKENS = new Set(['self', '@self', '@me', 'current', '-'])

function isDir(p) {
    try {
        return lstatSync(p).isDirectory()
    } catch {
        return false
    }
}

function sessionMatchesPrefix(session, prefix) {
    if (typeof session.id === 'string' && session.id.startsWith(prefix)) return true
    const meta = session.metadata ?? {}
    return [meta.agentSessionId, meta.cursorSessionId, meta.codexSessionId, meta.claudeSessionId, meta.opencodeSessionId]
        .some((id) => typeof id === 'string' && id.startsWith(prefix))
}

const args = process.argv.slice(2)
const mode = args[0]
if (!mode || !['static', 'proxy', 'stop'].includes(mode)) {
    console.error('usage: hapi-preview.mjs static [<session-prefix>|self] <dir> [name] [ttlHours]')
    console.error('       hapi-preview.mjs proxy [<session-prefix>|self] <port|url> [name]')
    console.error('       hapi-preview.mjs stop  [<session-prefix>|self] [--all | --name <name>]')
    process.exit(2)
}

const rest = args.slice(1)

// Decide whether the first remaining arg is a session selector or the mode's
// value: for `static` a directory path is the value; for `proxy` a port/URL;
// for `stop` a flag. Anything else (or an explicit self token) is a selector.
function isModeValue(value) {
    if (SELF_TOKENS.has(value)) return false
    if (mode === 'static') return isDir(value)
    if (mode === 'proxy') return /^\d+$/.test(value) || /^https?:\/\//.test(value)
    return value.startsWith('--')
}

let sessionArg = null
if (rest.length > 0 && !isModeValue(rest[0])) {
    sessionArg = rest.shift()
}
if (sessionArg === null && process.env.HAPI_SESSION_ID) {
    sessionArg = process.env.HAPI_SESSION_ID
}

// Parse the remaining args per mode.
let target
let name
let ttlHours
let all = false
let stopName
if (mode === 'static') {
    target = rest[0]
    name = rest[1]
    ttlHours = rest[2] ? Number(rest[2]) : undefined
    if (!target || !isDir(target)) {
        console.error(`not a directory: ${target}`)
        process.exit(2)
    }
} else if (mode === 'proxy') {
    target = rest[0]
    name = rest[1]
    if (!target) {
        console.error('missing <port|url>')
        process.exit(2)
    }
} else {
    const flag = rest[0]
    if (flag === '--all') {
        all = true
    } else if (flag === '--name') {
        stopName = rest[1]
    } else {
        console.error('stop needs --all or --name <name>')
        process.exit(2)
    }
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
    const detailRes = await fetch(`${HAPI_HOST}/api/sessions/${encodeURIComponent(sessionId)}`, { headers: authHeaders })
    if (!detailRes.ok) return null
    const detailBody = await detailRes.json()
    return detailBody.session ?? detailBody
}

let session
if (sessionArg && sessionArg.length >= 36) {
    session = await fetchSessionDetail(sessionArg)
} else if (sessionArg) {
    const sessionsRes = await fetch(`${HAPI_HOST}/api/sessions?limit=500`, { headers: authHeaders })
    const sessions = (await sessionsRes.json()).sessions ?? []
    const matches = sessions.filter((candidate) => sessionMatchesPrefix(candidate, sessionArg))
    if (matches.length !== 1) {
        console.error(`expected exactly one session for prefix ${sessionArg}, got ${matches.length}`)
        process.exit(4)
    }
    session = await fetchSessionDetail(matches[0].id) ?? matches[0]
} else {
    console.error('cannot self-resolve: $HAPI_SESSION_ID is not set; pass a session id prefix')
    process.exit(4)
}

const mcpUrl = session.metadata?.hapiMcpUrl
if (!mcpUrl) {
    console.error('session has no hapiMcpUrl metadata (restart the session CLI after MCP server start)')
    process.exit(5)
}

console.error(`hapi-preview: session=${session.id} mcp=${mcpUrl}`)

const client = new Client({ name: 'hapi-preview', version: '1.0.0' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)))

let result
if (mode === 'static') {
    result = await client.callTool({ name: 'preview_static', arguments: { path: target, name, ttlHours } })
} else if (mode === 'proxy') {
    const isPort = /^\d+$/.test(target)
    result = await client.callTool({
        name: 'preview_proxy',
        arguments: isPort ? { port: Number(target), name } : { url: target, name }
    })
} else {
    result = await client.callTool({ name: 'preview_stop', arguments: all ? { all: true } : { name: stopName } })
}

await client.close()
console.log(JSON.stringify(result, null, 2))
