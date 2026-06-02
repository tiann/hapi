#!/usr/bin/env bun
/**
 * Smoke-test the FCM permission-request enrichment path end-to-end.
 *
 * Imports the real `FcmNotificationChannel` from the active driver tree
 * so any change to the enrichment helper or body format is exercised
 * exactly as production would emit it. Uses the live FcmService against
 * the real Firebase project, so the payload reaches the registered
 * companion device(s).
 *
 * Usage:
 *   bun run scripts/tooling/hapi-companion-fcm-permission-smoke.mjs \
 *       [--tool Edit|Bash|Read|Write|Grep|WebFetch|TodoWrite] \
 *       [--session <id>] [--namespace <ns>]
 *
 * Defaults: tool=Edit, session=most-recently-active, namespace=default.
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const repoFromScript = join(scriptDir, '../..')
const hubRoot = existsSync(join(homedir(), 'coding/hapi-active'))
    ? realpathSync(join(homedir(), 'coding/hapi-active'))
    : repoFromScript

const { FcmNotificationChannel } = await import(
    join(hubRoot, 'hub/src/fcm/fcmNotificationChannel.ts')
)
const { FcmService } = await import(join(hubRoot, 'hub/src/fcm/fcmService.ts'))

function loadEnvFile(path) {
    if (!existsSync(path)) return
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq < 0) continue
        const key = trimmed.slice(0, eq)
        let val = trimmed.slice(eq + 1)
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
        }
        if (process.env[key] === undefined) process.env[key] = val
    }
}

loadEnvFile(join(homedir(), '.hapi', 'hub.env'))

const saPath = process.env.FCM_SERVICE_ACCOUNT_PATH
const projectId = process.env.FCM_PROJECT_ID
if (!saPath || !projectId) {
    console.error('Missing FCM_SERVICE_ACCOUNT_PATH or FCM_PROJECT_ID in ~/.hapi/hub.env')
    process.exit(1)
}

const args = process.argv.slice(2)
let tool = 'Edit'
let sessionArg
let namespace = 'default'
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tool' && args[i + 1]) tool = args[++i]
    else if (args[i] === '--session' && args[i + 1]) sessionArg = args[++i]
    else if (args[i] === '--namespace' && args[i + 1]) namespace = args[++i]
}

// Tool-specific arguments that exercise the full formatToolArgumentsDetailed
// switch table. Edit gives the most expressive output (file + old + new).
const sampleArgs = {
    Edit: {
        file_path: '/home/heavygee/coding/hapi-driver/hub/src/fcm/fcmNotificationChannel.ts',
        old_string: 'const toolName = request?.tool ? ` (${request.tool})` : \'\'',
        new_string: 'const compact = request ? formatToolArgumentsCompact(request.tool, request.arguments) : \'\''
    },
    Bash: { command: 'cd ~/coding/hapi-driver && bun run --cwd hub typecheck && bun run --cwd hub test' },
    Read: { file_path: '/home/heavygee/coding/hapi-companion/wear/src/main/java/dev/hapi/companion/wear/notify/WearNotificationHelper.kt' },
    Write: { file_path: '/tmp/test-output.json', content: 'x'.repeat(2048) },
    Grep: { pattern: 'formatToolArgumentsDetailed', path: 'hub/src' },
    WebFetch: { url: 'https://hapi.tail9944ee.ts.net/sessions/abc-123' },
    TodoWrite: { todos: [{ id: 'a', content: 'one', status: 'pending' }, { id: 'b', content: 'two', status: 'pending' }] }
}
const argsForTool = sampleArgs[tool] ?? {}

const settingsPath = join(homedir(), '.hapi', 'settings.json')
const hubUrl = process.env.HAPI_HUB_URL ?? 'http://127.0.0.1:3006'

async function pickSession() {
    if (sessionArg) return sessionArg
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const authRes = await fetch(`${hubUrl}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: settings.cliApiToken })
    })
    if (!authRes.ok) throw new Error(`auth failed: ${authRes.status}`)
    const { token } = await authRes.json()
    const res = await fetch(`${hubUrl}/api/sessions`, {
        headers: { authorization: `Bearer ${token}` }
    })
    if (!res.ok) throw new Error(`sessions list failed: ${res.status}`)
    const { sessions } = await res.json()
    const active = (sessions ?? []).filter((s) => s.active)
    active.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    if (active.length === 0) throw new Error('no active sessions; spawn one or pass --session')
    return active[0].id
}

const dbPath = process.env.HAPI_DB_PATH ?? join(homedir(), '.hapi', 'hapi.db')
const { Database } = await import('bun:sqlite')
const db = new Database(dbPath, { readonly: true })

const sessionId = await pickSession()
console.log(`session=${sessionId} tool=${tool} namespace=${namespace}`)

// Use a real Store wrapper so FcmService can fetch device tokens. The
// channel only needs FcmService for delivery; no full sync engine needed.
const { Store } = await import(join(hubRoot, 'hub/src/store/index.ts'))
const store = new Store(dbPath)
const fcmService = new FcmService(projectId, JSON.parse(readFileSync(saPath, 'utf8')), store)

// Stubs for the SSE+visibility deps - we want the FCM path to fire, so
// `hasVisibleConnection` returns false and `sendToast` is never reached.
const sseStub = { sendToast: async () => 0 }
const visibilityStub = { hasVisibleConnection: () => false }

const channel = new FcmNotificationChannel(fcmService, sseStub, visibilityStub)

// Construct a Session-shaped object that triggers `sendPermissionRequest`'s
// enrichment branch. agentState.requests is the only thing the channel
// needs beyond the basics.
const fakeSession = {
    id: sessionId,
    namespace,
    name: 'Permission smoke test',
    active: true,
    metadata: { flavor: 'codex', name: 'Permission smoke test' },
    agentState: {
        requests: {
            'smoke-req-1': {
                tool,
                arguments: argsForTool,
                createdAt: Date.now()
            }
        }
    }
}

await channel.sendPermissionRequest(fakeSession)
console.log(`OK delivered permission-request smoke to namespace='${namespace}'`)
console.log(`Tap the watch notification to expand the body and see the full detail.`)
