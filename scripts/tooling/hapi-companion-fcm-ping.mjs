#!/usr/bin/env bun
/**
 * Send a data-only FCM ping to registered companion devices (bypasses PWA visibility).
 *
 * Usage:
 *   bun run scripts/tooling/hapi-companion-fcm-ping.mjs [--session <id>]
 *
 * Env: reads ~/.hapi/hub.env for FCM_* ; lists sessions from HAPI_HUB_URL (default :3006).
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
const { getFcmAccessToken } = await import(join(hubRoot, 'hub/src/fcm/fcmAuth.ts'))

const CONTRACT_VERSION = '1'
const hubEnvPath = join(homedir(), '.hapi', 'hub.env')
const settingsPath = join(homedir(), '.hapi', 'settings.json')
const hubUrl = process.env.HAPI_HUB_URL ?? 'http://127.0.0.1:3006'

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

loadEnvFile(hubEnvPath)

const saPath = process.env.FCM_SERVICE_ACCOUNT_PATH
const projectId = process.env.FCM_PROJECT_ID
if (!saPath || !projectId) {
    console.error('Missing FCM_SERVICE_ACCOUNT_PATH or FCM_PROJECT_ID in ~/.hapi/hub.env')
    process.exit(1)
}

const serviceAccount = JSON.parse(readFileSync(saPath, 'utf8'))

async function hubJwt() {
    if (process.env.HAPI_JWT) return process.env.HAPI_JWT
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const res = await fetch(`${hubUrl}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: settings.cliApiToken })
    })
    if (!res.ok) throw new Error(`auth failed: ${res.status}`)
    const body = await res.json()
    return body.token
}

async function pickSession(jwt, sessionArg) {
    if (sessionArg) return sessionArg
    const res = await fetch(`${hubUrl}/api/sessions`, {
        headers: { authorization: `Bearer ${jwt}` }
    })
    if (!res.ok) throw new Error(`sessions list failed: ${res.status}`)
    const { sessions } = await res.json()
    const active = (sessions ?? []).filter((s) => s.active)
    if (active.length === 0) {
        const names = (sessions ?? []).slice(0, 5).map((s) => `${s.id?.slice(0, 8)}… active=${s.active}`).join(', ')
        throw new Error(
            `no active sessions for watch reply (hub requires active). Recent: ${names || 'none'} — resume one in PWA or spawn a runner session`
        )
    }
    active.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return active[0].id
}

function parseArgs() {
    const args = process.argv.slice(2)
    let session
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--session' && args[i + 1]) {
            session = args[++i]
        }
    }
    return { session }
}

async function sendDataOnly(token, payload) {
    const dataRecord = {
        type: payload.data.type,
        sessionId: payload.data.sessionId,
        url: payload.data.url,
        title: payload.data.title,
        body: payload.data.body,
        contractVersion: payload.data.contractVersion
    }
    const message = {
        token,
        data: dataRecord,
        android: { priority: 'HIGH' }
    }
    const accessToken = await getFcmAccessToken(serviceAccount)
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({ message })
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(`FCM ${res.status}: ${text}`)
    }
    return res.json()
}

async function main() {
    const { session: sessionArg } = parseArgs()
    const jwt = await hubJwt()
    const sessionId = await pickSession(jwt, sessionArg)
    const namespace = 'default'

    const dbPath = process.env.HAPI_DB_PATH ?? join(homedir(), '.hapi', 'hapi.db')
    const { Database } = await import('bun:sqlite')
    const db = new Database(dbPath, { readonly: true })
    const rows = db
        .query(
            `SELECT token, platform FROM fcm_devices WHERE namespace = ? ORDER BY updated_at DESC`
        )
        .all(namespace)
    if (rows.length === 0) {
        console.error('No FCM devices registered — open companion app and bind hub')
        process.exit(1)
    }

    const payload = {
        title: 'HAPI companion ping',
        body: 'Wear companion ping — reply on watch if you see this.',
        data: {
            type: 'ready',
            sessionId,
            url: `/sessions/${sessionId}`,
            title: 'HAPI companion ping',
            body: 'Wear companion ping — reply on watch if you see this.',
            contractVersion: CONTRACT_VERSION
        }
    }

    console.log(`Pinging session ${sessionId} → ${rows.length} device(s)`)
    for (const row of rows) {
        try {
            await sendDataOnly(row.token, payload)
            console.log(`  OK ${row.platform} ${row.token.slice(0, 12)}…`)
        } catch (err) {
            console.error(`  FAIL ${row.platform}:`, err instanceof Error ? err.message : err)
        }
    }
    console.log('Background the PWA on phone if you want FCM via hub events later; this script bypasses visibility.')
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
