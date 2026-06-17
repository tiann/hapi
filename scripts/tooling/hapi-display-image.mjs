#!/usr/bin/env bun
/**
 * Post a local image inline to a HAPI session via the session CLI's display_image MCP tool.
 *
 * Calls the HTTP MCP server owned by the live session process (hostPid metadata) so
 * generated-image bytes stay in that CLI's memory for /generated-images/:id RPC.
 *
 * Usage:
 *   bun scripts/tooling/hapi-display-image.mjs <session-id-prefix> <image-path> [title]
 */

import { readFileSync, lstatSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const HAPI_HOST = process.env.HAPI_HOST ?? 'http://localhost:3006'
const SETTINGS = process.env.HAPI_SETTINGS ?? `${process.env.HOME}/.hapi/settings.json`

const sessionArg = process.argv[2]
const imagePath = process.argv[3]
const title = process.argv[4]

if (!sessionArg || !imagePath) {
    console.error('usage: hapi-display-image.mjs <session-id-prefix> <image-path> [title]')
    process.exit(2)
}

if (!lstatSync(imagePath).isFile()) {
    console.error(`not a file: ${imagePath}`)
    process.exit(2)
}

const token = JSON.parse(readFileSync(SETTINGS, 'utf8')).cliApiToken
const authRes = await fetch(`${HAPI_HOST}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: `${token}:default` }),
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
const session = sessions.find((s) => s.id.startsWith(sessionArg))
if (!session) {
    console.error(`no session for prefix ${sessionArg}`)
    process.exit(4)
}

const hostPid = session.metadata?.hostPid
if (!hostPid) {
    console.error('session has no hostPid (inactive CLI?)')
    process.exit(5)
}

const ssOut = execSync(`ss -ltnp 2>/dev/null | rg 'pid=${hostPid},' || true`, { encoding: 'utf8' })
const portMatch = ssOut.match(/127\.0\.0\.1:(\d+)/)
if (!portMatch) {
    console.error(`no localhost listen port for pid ${hostPid}`)
    process.exit(6)
}
const mcpUrl = `http://127.0.0.1:${portMatch[1]}/`
console.error(`hapi-display-image: session=${session.id} pid=${hostPid} mcp=${mcpUrl}`)

const client = new Client({ name: 'hapi-display-image', version: '1.0.0' }, { capabilities: {} })
const transport = new StreamableHTTPClientTransport(new URL(mcpUrl))
await client.connect(transport)
const result = await client.callTool({
    name: 'display_image',
    arguments: { path: imagePath, title: title ?? undefined },
})
await client.close()
console.log(JSON.stringify(result, null, 2))
