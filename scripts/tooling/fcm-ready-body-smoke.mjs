#!/usr/bin/env bun
// Smoke: replay the new FCM 'ready' body composition against a real session
// from the live hub DB. Prints title + body that would have been sent without
// actually calling FCM, so we can eyeball whether AGENT_NOTIFY_SUMMARY parsing
// or text truncation is doing the right thing for real operator data.
//
// Usage:  HAPI_DB=/path/to/hapi.db bun run scripts/tooling/fcm-ready-body-smoke.mjs [sessionId]
// If no sessionId arg, picks the most recent session that has agent text.

import { Database } from 'bun:sqlite'
import path from 'node:path'
import os from 'node:os'

const driverRoot = path.resolve(import.meta.dir, '../../../hapi-driver')
const { FcmNotificationChannel } = await import(path.join(driverRoot, 'hub/src/fcm/fcmNotificationChannel.ts'))
const { Store } = await import(path.join(driverRoot, 'hub/src/store/index.ts'))

const dbPath = process.env.HAPI_DB ?? path.join(os.homedir(), '.hapi', 'hapi.db')
console.log(`[smoke] db=${dbPath}`)

const ro = new Database(dbPath, { readonly: true })
const arg = process.argv[2]
let sessionRow
if (arg) {
    sessionRow = ro.prepare('SELECT id, namespace, metadata FROM sessions WHERE id = ?').get(arg)
} else {
    sessionRow = ro.prepare(`
        SELECT s.id, s.namespace, s.metadata
        FROM sessions s
        JOIN messages m ON m.session_id = s.id
        WHERE json_extract(m.content, '$.role') = 'agent'
          AND (json_extract(m.content, '$.content.type') = 'codex'
               AND json_extract(m.content, '$.content.data.type') = 'message'
               OR json_extract(m.content, '$.content.type') = 'output'
               AND json_extract(m.content, '$.content.data.type') = 'assistant')
        ORDER BY m.seq DESC
        LIMIT 1
    `).get()
}
ro.close()

if (!sessionRow) {
    console.error('[smoke] no session found with agent text')
    process.exit(1)
}

const meta = sessionRow.metadata ? JSON.parse(sessionRow.metadata) : {}
const session = {
    id: sessionRow.id,
    namespace: sessionRow.namespace,
    name: meta.name ?? sessionRow.id.slice(0, 8),
    active: true,
    metadata: meta,
    agentState: null
}
console.log(`[smoke] session=${session.id} flavor=${meta.flavor ?? '?'} name=${meta.name ?? '(none)'}`)

const store = new Store(dbPath)
const captured = []
const fcmStub = {
    sendToNamespace: async (_ns, payload) => {
        captured.push(payload)
        return { sent: 1, failed: 0, invalidTokens: [] }
    }
}
const sseStub = { sendToast: async () => 0 }
const visStub = { hasVisibleConnection: () => false }

const channel = new FcmNotificationChannel(fcmStub, sseStub, visStub, store)
await channel.sendReady(session)
store.close()

if (captured.length === 0) {
    console.error('[smoke] no payload captured')
    process.exit(2)
}
const p = captured[0]
console.log('---')
console.log('title:', p.title)
console.log('body:')
console.log(p.body.split('\n').map(line => '  ' + line).join('\n'))
console.log('---')
console.log('data.notifySummary:', p.data.notifySummary ?? '(none)')
console.log('data.sessionName:', p.data.sessionName)
console.log('data.url:', p.data.url)
